import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { DEVICE_KDF, DEVICE_SALT_BYTES, DEVICE_SECRET_BYTES, LAST_SEEN_PERSIST_MS, type DeviceKdfParams } from './DeviceStore';
import { errMsg, isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from '../a2aRemote/storeFile';
import {
  GUEST_LIMITS,
  GUEST_RECORD_V,
  formatGuestCredential,
  isGuestId,
  parseGuestCredential,
  parseGuestScope,
  sanitizeGuestName,
  type GuestBotView,
  type GuestScope,
} from '../../shared/guestBots';

/**
 * The owner's guest bots (`guest-bots.json` in the wmux data directory): who
 * may join one Bots conversation from outside, and the owner's switch for the
 * whole feature (off until the owner turns it on).
 *
 * Secrets are handled like DeviceStore's and PeerStore's: 32 CSPRNG bytes
 * handed out once, and only a per-guest salted scrypt output (the same
 * `DEVICE_KDF` parameters, stored per record) on disk — the file is not a
 * credential. A token is verified, never read back, so it does not belong in
 * the OS keychain the bot secrets use. Verification is constant-time, with a
 * SHA-256 cache so a guest pays one derivation per daemon boot; the
 * derivation is the async `crypto.scrypt`, serialized per guest, and wrong
 * secrets are budgeted per guest id (GUEST_LIMITS.failuresPerWindow).
 *
 * Revocation is immediate: the record is marked in memory before the write,
 * and `resolve` checks it on every request (guests hold no stream). A failed
 * write keeps the in-memory revocation and throws.
 *
 * Corrupt file: FAIL-CLOSED — the store starts empty and switched off (nobody
 * authenticates), the original is kept as `guest-bots.json.corrupt-<ts>`. An
 * unreadable file leaves the store unavailable and the file untouched.
 */

export const GUEST_BOTS_FILE = 'guest-bots.json';

export type GuestAuthResult =
  | { ok: true; guestId: string; name: string; scope: GuestScope; /** ms; the guest reads nothing older. */ createdAt: number }
  | { ok: false; reason: 'unknown' | 'revoked' };

interface StoredGuest {
  v: 1;
  guestId: string;
  name: string;
  workspaceId: string;
  threadId: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  secretHash: string;
  salt: string;
  kdf: DeviceKdfParams;
}

interface GuestFileV1 {
  v: 1;
  enabled: boolean;
  guests: StoredGuest[];
}

/** Revoked rows kept (newest first); older ones are dropped on the next revoke. */
export const REVOKED_GUESTS_KEPT = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const VERIFIED_CACHE_CAP = 64;

const REJECT_UNKNOWN: GuestAuthResult = Object.freeze({ ok: false as const, reason: 'unknown' as const });
const REJECT_REVOKED: GuestAuthResult = Object.freeze({ ok: false as const, reason: 'revoked' as const });

export class GuestStoreError extends Error {
  constructor(readonly code: 'invalid' | 'too-many' | 'unavailable', message: string) {
    super(message);
    this.name = 'GuestStoreError';
  }
}

export interface GuestBotStoreOptions {
  /** The wmux data directory. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
}

export class GuestBotStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly guests = new Map<string, StoredGuest>();
  private readonly verified = new Map<string, { secretDigest: Buffer; hashHex: string }>();
  private readonly lastSeenPersistedAt = new Map<string, number>();
  private readonly failures = new Map<string, { windowStart: number; count: number }>();
  private readonly kdfChains = new Map<string, Promise<void>>();
  private writable = true;
  private on = false;
  private derivations = 0;

  constructor(opts: GuestBotStoreOptions) {
    this.filePath = path.join(opts.dir, GUEST_BOTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.load();
  }

  /** The owner's switch. A store that could not be read is off. */
  enabled(): boolean {
    return this.writable && this.on;
  }

  /** Turn the feature on or off. Persists first; throws when it cannot. */
  setEnabled(enabled: boolean): void {
    if (!this.writable) throw storeUnavailable(GUEST_BOTS_FILE);
    const before = this.on;
    this.on = enabled;
    try {
      this.persist();
    } catch (err) {
      // Turning off stays off in memory (fail closed); turning on does not land.
      if (enabled) this.on = before;
      throw err;
    }
  }

  /** The owner's view, newest first. Never carries the hash, salt or KDF. */
  list(): GuestBotView[] {
    return [...this.guests.values()].map(project).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Add a guest for one conversation and hand out its token, once. Persists
   * BEFORE returning; rolls back and throws when the file cannot be written.
   */
  async create(params: { name: unknown; scope: unknown }): Promise<{ guest: GuestBotView; token: string }> {
    if (!this.writable) throw new GuestStoreError('unavailable', 'guest store is unavailable');
    const name = sanitizeGuestName(params.name);
    const scope = parseGuestScope(params.scope);
    if (!name || !scope) throw new GuestStoreError('invalid', 'a guest needs a name and one conversation');
    this.assertRoom();
    const secret = crypto.randomBytes(DEVICE_SECRET_BYTES).toString('base64url');
    const salt = crypto.randomBytes(DEVICE_SALT_BYTES);
    const kdf: DeviceKdfParams = { ...DEVICE_KDF };
    const secretHash = (await derive(secret, salt, kdf)).toString('hex');
    // Re-checked after the await: two concurrent creates must not pass the cap.
    if (!this.writable) throw new GuestStoreError('unavailable', 'guest store is unavailable');
    this.assertRoom();
    let guestId = crypto.randomUUID();
    while (this.guests.has(guestId)) guestId = crypto.randomUUID();
    const at = this.now();
    const rec: StoredGuest = {
      v: GUEST_RECORD_V,
      guestId,
      name,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      createdAt: new Date(at).toISOString(),
      secretHash,
      salt: salt.toString('hex'),
      kdf,
    };
    this.guests.set(guestId, rec);
    try {
      this.persist();
    } catch (err) {
      this.guests.delete(guestId);
      throw err;
    }
    this.rememberVerified(guestId, sha256(Buffer.from(secret, 'utf8')), rec.secretHash);
    this.lastSeenPersistedAt.set(guestId, at);
    return { guest: project(rec), token: formatGuestCredential({ guestId, secret }) };
  }

  /**
   * Resolve a guest credential. Total; never throws. An unknown id or a
   * revoked guest answers at once, without a derivation; a guest over its
   * wrong-secret budget answers `unknown` without deriving; a wrong secret
   * is `unknown`, never saying which half was right.
   */
  async resolve(guestId: string, secret: string): Promise<GuestAuthResult> {
    const rec = typeof guestId === 'string' ? this.guests.get(guestId) : undefined;
    if (!rec) return REJECT_UNKNOWN;
    if (rec.revokedAt !== undefined) return REJECT_REVOKED;
    // The wrong-secret budget is checked in verify(), after the cache: a
    // flood of wrong secrets never locks out the guest whose secret was
    // verified already.
    if (typeof secret !== 'string' || !parseGuestCredential(formatGuestCredential({ guestId: rec.guestId, secret }))) {
      this.noteFailure(rec.guestId);
      return REJECT_UNKNOWN;
    }
    if (!(await this.verify(rec, secret))) return REJECT_UNKNOWN;
    // Revoked while the derivation was in flight.
    if (rec.revokedAt !== undefined || this.guests.get(rec.guestId) !== rec) return REJECT_REVOKED;
    const createdAt = Date.parse(rec.createdAt);
    return {
      ok: true, guestId: rec.guestId, name: rec.name,
      scope: { workspaceId: rec.workspaceId, threadId: rec.threadId as GuestScope['threadId'] },
      // A record with no readable date reads nothing from before now.
      createdAt: Number.isFinite(createdAt) ? createdAt : this.now(),
    };
  }

  /** Note a successful request: in memory always, on disk at most once per LAST_SEEN_PERSIST_MS. */
  touch(guestId: string): void {
    const rec = this.guests.get(guestId);
    if (!rec || rec.revokedAt !== undefined) return;
    const at = this.now();
    rec.lastSeenAt = new Date(at).toISOString();
    if (!this.writable || at - (this.lastSeenPersistedAt.get(guestId) ?? 0) < LAST_SEEN_PERSIST_MS) return;
    try {
      this.persist();
      this.lastSeenPersistedAt.set(guestId, at);
    } catch (err) {
      this.log('warn', `[guest-bots] could not persist lastSeenAt for ${guestId}: ${errMsg(err)}`);
    }
  }

  /**
   * Revoke a guest: refused from this moment on. False when it is unknown or
   * already revoked. A failed write keeps the revocation in memory and throws.
   */
  revoke(guestId: string): boolean {
    const rec = this.guests.get(guestId);
    if (!rec || rec.revokedAt !== undefined) return false;
    rec.revokedAt = new Date(this.now()).toISOString();
    this.verified.delete(guestId);
    this.pruneRevoked();
    if (!this.writable) throw storeUnavailable(GUEST_BOTS_FILE);
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[guest-bots] guest ${guestId} is revoked in memory but could not be persisted`);
      throw err;
    }
    return true;
  }

  /** Test/diagnostic view. Holds no secret material. */
  stats(): { derivations: number; guests: number } {
    return { derivations: this.derivations, guests: this.guests.size };
  }

  // --- internals --------------------------------------------------------------

  private assertRoom(): void {
    const live = [...this.guests.values()].filter((g) => g.revokedAt === undefined).length;
    if (live >= GUEST_LIMITS.liveMax) throw new GuestStoreError('too-many', `at most ${GUEST_LIMITS.liveMax} guest bots at once; revoke one first`);
  }

  private pruneRevoked(): void {
    const revoked = [...this.guests.values()]
      .filter((g) => g.revokedAt !== undefined)
      .sort((a, b) => (b.revokedAt ?? '').localeCompare(a.revokedAt ?? ''));
    for (const old of revoked.slice(REVOKED_GUESTS_KEPT)) {
      this.guests.delete(old.guestId);
      this.verified.delete(old.guestId);
      this.lastSeenPersistedAt.delete(old.guestId);
      this.failures.delete(old.guestId);
    }
  }

  private overBudget(guestId: string): boolean {
    const f = this.failures.get(guestId);
    return f !== undefined && this.now() - f.windowStart < GUEST_LIMITS.failureWindowMs && f.count >= GUEST_LIMITS.failuresPerWindow;
  }

  private noteFailure(guestId: string): void {
    const at = this.now();
    const f = this.failures.get(guestId);
    if (!f || at - f.windowStart >= GUEST_LIMITS.failureWindowMs) this.failures.set(guestId, { windowStart: at, count: 1 });
    else f.count += 1;
  }

  private async verify(rec: StoredGuest, secret: string): Promise<boolean> {
    const secretBuf = Buffer.from(secret, 'utf8');
    const digest = sha256(secretBuf);
    if (this.cacheHit(rec, digest)) return true;
    return this.serializeKdf(rec.guestId, async () => {
      if (this.cacheHit(rec, digest)) return true;
      if (this.overBudget(rec.guestId)) return false;
      let derived: Buffer;
      try {
        this.derivations += 1;
        derived = await derive(secretBuf, Buffer.from(rec.salt, 'hex'), rec.kdf);
      } catch (err) {
        this.log('warn', `[guest-bots] guest ${rec.guestId} hash could not be derived: ${errMsg(err)}`);
        this.noteFailure(rec.guestId);
        return false;
      }
      const expected = Buffer.from(rec.secretHash, 'hex');
      const ok = expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
      if (ok) this.rememberVerified(rec.guestId, digest, rec.secretHash);
      else this.noteFailure(rec.guestId);
      return ok;
    });
  }

  private cacheHit(rec: StoredGuest, digest: Buffer): boolean {
    const cached = this.verified.get(rec.guestId);
    return cached !== undefined && cached.hashHex === rec.secretHash && crypto.timingSafeEqual(digest, cached.secretDigest);
  }

  private serializeKdf<T>(guestId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.kdfChains.get(guestId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.kdfChains.set(guestId, tail);
    void tail.then(() => {
      if (this.kdfChains.get(guestId) === tail) this.kdfChains.delete(guestId);
    });
    return run;
  }

  private rememberVerified(guestId: string, secretDigest: Buffer, hashHex: string): void {
    this.verified.set(guestId, { secretDigest, hashHex });
    if (this.verified.size > VERIFIED_CACHE_CAP) {
      const oldest = this.verified.keys().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
  }

  private persist(): void {
    const file: GuestFileV1 = { v: GUEST_RECORD_V, enabled: this.on, guests: [...this.guests.values()] };
    this.write(this.filePath, file);
    this.scheduleHarden(this.filePath);
  }

  private load(): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: GUEST_BOTS_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'error',
      emptyMeans: 'no guest bot can connect and the feature is off until the owner adds guests again',
    });
    this.writable = writable;
    this.on = value?.enabled ?? false;
    for (const rec of value?.guests ?? []) this.guests.set(rec.guestId, rec);
  }
}

function project(r: StoredGuest): GuestBotView {
  return {
    v: 1,
    guestId: r.guestId,
    name: r.name,
    scope: { workspaceId: r.workspaceId, threadId: r.threadId as GuestScope['threadId'] },
    createdAt: r.createdAt,
    ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
    ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
  };
}

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

function derive(secret: string | Buffer, salt: Buffer, kdf: DeviceKdfParams): Promise<Buffer> {
  return scryptAsync(secret, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });
}

function sha256(input: Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

/** Whole-file validation (fail-closed): any record we cannot verify against rejects the file. */
function coerceFile(raw: unknown): { enabled: boolean; guests: StoredGuest[] } | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || typeof raw['enabled'] !== 'boolean' || !Array.isArray(raw['guests'])) return null;
  const out: StoredGuest[] = [];
  const seen = new Set<string>();
  for (const r of raw['guests']) {
    if (!isPlainObject(r) || r['v'] !== 1) return null;
    const { guestId, name, createdAt, lastSeenAt, revokedAt, secretHash, salt } = r;
    const kdf = coerceKdf(r['kdf']);
    const scope = parseGuestScope({ workspaceId: r['workspaceId'], threadId: r['threadId'] });
    const cleanName = sanitizeGuestName(name);
    if (!isGuestId(guestId) || seen.has(guestId) || !cleanName || !scope || !isIsoString(createdAt)) return null;
    if (lastSeenAt !== undefined && !isIsoString(lastSeenAt)) return null;
    if (revokedAt !== undefined && !isIsoString(revokedAt)) return null;
    if (!isHex(secretHash) || !isHex(salt) || !kdf || secretHash.length !== kdf.keylen * 2) return null;
    seen.add(guestId);
    out.push({
      v: 1,
      guestId,
      name: cleanName,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      createdAt,
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      ...(revokedAt !== undefined ? { revokedAt } : {}),
      secretHash,
      salt,
      kdf,
    });
  }
  return { enabled: raw['enabled'], guests: out };
}

/** DeviceStore's / PeerStore's bounds: a hand-edited record is no CPU or memory lever. */
function coerceKdf(raw: unknown): DeviceKdfParams | null {
  if (!isPlainObject(raw) || raw['algo'] !== 'scrypt') return null;
  const N = positiveInt(raw['N']);
  const r = positiveInt(raw['r']);
  const p = positiveInt(raw['p']);
  const keylen = positiveInt(raw['keylen']);
  if (!N || !r || !p || !keylen) return null;
  if (N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20) return null;
  if (r > 32 || p > 16 || keylen < 16 || keylen > 128) return null;
  if (128 * N * r > SCRYPT_MAXMEM) return null;
  return { algo: 'scrypt', N, r, p, keylen };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
