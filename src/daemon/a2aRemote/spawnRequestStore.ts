import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import {
  SPAWN_DECIDED_PER_HOST_MAX,
  SPAWN_REQUEST_KEEP_MS,
  SPAWN_REQUESTS_MAX,
  isSpawnCode,
  isSpawnId,
  parseSpawnRequest,
  type A2aSpawnCode,
  type A2aSpawnRequestSummary,
  type A2aSpawnRequestV1,
} from '../../shared/a2aSpawn';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Remote spawn requests this PC received (`spawn-requests.json`), keyed by
 * (hostId, spawnId). It is what makes a resend harmless: the same request
 * again is answered from here and never decided twice; the same id with
 * another body is a conflict.
 *
 * The prompt is kept only while a request is pending (its card and its first
 * task need it after a restart); a decided record keeps the fingerprint and
 * the outcome, never the text. A decided record goes `SPAWN_REQUEST_KEEP_MS`
 * after it was decided (not after the expiry the asker chose); one PC may
 * hold at most `SPAWN_DECIDED_PER_HOST_MAX` decided records, and past that
 * its new requests wait. Each write lands before memory changes, so a
 * failed write leaves nothing behind. The decision's answer is marked `sent`
 * once it is queued, so one that never left is sent again on recovery.
 * At most `SPAWN_REQUESTS_MAX` records are kept in all.
 *
 * Load: a record this build cannot read is skipped, never the whole file.
 */

export const SPAWN_REQUESTS_FILE = 'spawn-requests.json';

export interface SpawnRequestRecordV1 {
  v: 1;
  hostId: HostId;
  spawnId: string;
  /** sha256 of the request body as received (its canonical JSON). */
  fingerprint: string;
  agent: A2aSpawnRequestV1['agent'];
  rootId: string;
  state: 'pending' | 'decided';
  code?: A2aSpawnCode;
  receivedAt: string;
  expiresAt: string;
  /** Decided only. */
  decidedAt?: string;
  /** Decided only: its spawn-result is in the outbox. */
  sent?: true;
  /** Pending only. */
  request?: A2aSpawnRequestV1;
}

export type SpawnReceive =
  | { kind: 'new'; rec: SpawnRequestRecordV1 }
  | { kind: 'duplicate'; rec: SpawnRequestRecordV1 }
  | { kind: 'conflict' }
  /** No room: this PC's decided records, or all records, are at their cap. */
  | { kind: 'full' };

export interface SpawnRequestStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

const key = (hostId: HostId, spawnId: string): string => `${hostId}:${spawnId}`;

export function spawnFingerprint(req: A2aSpawnRequestV1): string {
  const canonical = {
    v: req.v, spawnId: req.spawnId, agent: req.agent,
    folder: { root: req.folder.root, sub: req.folder.sub ?? '' },
    text: req.text, expiresAt: req.expiresAt, from: req.from,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class SpawnRequestStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly records = new Map<string, SpawnRequestRecordV1>();
  private writable: boolean;

  constructor(opts: SpawnRequestStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_REQUESTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_REQUESTS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['records']) ? raw['records'] : null),
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'no remote spawn request is remembered',
    });
    this.writable = loaded.writable;
    for (const r of loaded.value ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(key(rec.hostId, rec.spawnId), rec);
      else this.log('warn', `[a2a-remote] ${SPAWN_REQUESTS_FILE}: a record this build cannot read was skipped`);
    }
  }

  get(hostId: HostId, spawnId: string): SpawnRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    return rec ? structuredClone(rec) : undefined;
  }

  pending(): SpawnRequestRecordV1[] {
    return [...this.records.values()].filter((r) => r.state === 'pending').map((r) => structuredClone(r));
  }

  pendingCount(hostId: HostId): number {
    return [...this.records.values()].filter((r) => r.hostId === hostId && r.state === 'pending').length;
  }

  /** Newest first, without the prompt. */
  summaries(): A2aSpawnRequestSummary[] {
    return [...this.records.values()]
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .map((r) => ({
        hostId: r.hostId, spawnId: r.spawnId, agent: r.agent, rootId: r.rootId, state: r.state,
        ...(r.code ? { code: r.code } : {}), receivedAt: r.receivedAt, expiresAt: r.expiresAt,
      }));
  }

  /** Decided records whose answer never reached the outbox. */
  unsent(): SpawnRequestRecordV1[] {
    return [...this.records.values()].filter((r) => r.state === 'decided' && !r.sent).map((r) => structuredClone(r));
  }

  /** Record a request that passed the cheap checks, pending its decision. */
  receive(hostId: HostId, req: A2aSpawnRequestV1): SpawnReceive {
    this.assertWritable();
    const fingerprint = spawnFingerprint(req);
    const known = this.records.get(key(hostId, req.spawnId));
    if (known) return known.fingerprint === fingerprint ? { kind: 'duplicate', rec: structuredClone(known) } : { kind: 'conflict' };
    this.prune();
    const decidedHere = [...this.records.values()].filter((r) => r.hostId === hostId && r.state === 'decided').length;
    if (this.records.size >= SPAWN_REQUESTS_MAX || decidedHere >= SPAWN_DECIDED_PER_HOST_MAX) return { kind: 'full' };
    const rec: SpawnRequestRecordV1 = {
      v: 1,
      hostId,
      spawnId: req.spawnId,
      fingerprint,
      agent: req.agent,
      rootId: req.folder.root,
      state: 'pending',
      request: structuredClone(req),
      receivedAt: new Date(this.now()).toISOString(),
      expiresAt: req.expiresAt,
    };
    this.commit((m) => m.set(key(hostId, req.spawnId), rec));
    return { kind: 'new', rec: structuredClone(rec) };
  }

  /** A pending request was decided: keep the outcome, drop the text. */
  decide(hostId: HostId, spawnId: string, code: A2aSpawnCode): SpawnRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || rec.state !== 'pending') return undefined;
    this.assertWritable();
    const { request: _dropped, ...rest } = rec;
    const next: SpawnRequestRecordV1 = { ...rest, state: 'decided', code, decidedAt: new Date(this.now()).toISOString() };
    this.commit((m) => m.set(key(hostId, spawnId), next));
    return structuredClone(next);
  }

  /** The decision's answer is in the outbox. */
  markSent(hostId: HostId, spawnId: string): void {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || rec.state !== 'decided' || rec.sent) return;
    this.assertWritable();
    this.commit((m) => m.set(key(hostId, spawnId), { ...rec, sent: true }));
  }

  /**
   * A paired PC was removed: its requests go, from memory at once (nothing
   * of that PC is decided or answered after this) and then from the file;
   * a write that fails is logged. Returns the pending ones dropped.
   */
  forgetHost(hostId: HostId): number {
    const gone = [...this.records.values()].filter((r) => r.hostId === hostId);
    if (gone.length === 0) return 0;
    for (const r of gone) this.records.delete(key(r.hostId, r.spawnId));
    try {
      this.assertWritable();
      this.write(this.filePath, { v: 1, records: [...this.records.values()] });
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('error', `[a2a-remote] ${SPAWN_REQUESTS_FILE}: not saved after forgetting ${hostId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return gone.filter((r) => r.state === 'pending').length;
  }

  /** Drop decided records kept past `SPAWN_REQUEST_KEEP_MS` since their decision. */
  prune(): number {
    const cutoff = this.now() - SPAWN_REQUEST_KEEP_MS;
    const stale = [...this.records.values()].filter((r) => r.state === 'decided' && Date.parse(r.decidedAt ?? r.receivedAt) < cutoff);
    if (stale.length === 0 || !this.writable) return 0;
    this.commit((m) => { for (const r of stale) m.delete(key(r.hostId, r.spawnId)); });
    return stale.length;
  }

  /** Write the changed records, then make them the live ones: a failed write changes nothing. */
  private commit(change: (m: Map<string, SpawnRequestRecordV1>) => void): void {
    const next = new Map(this.records);
    change(next);
    this.write(this.filePath, { v: 1, records: [...next.values()] });
    this.scheduleHarden(this.filePath);
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(SPAWN_REQUESTS_FILE);
  }
}

function coerceRecord(raw: unknown): SpawnRequestRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, spawnId, fingerprint, agent, rootId, state, code, receivedAt, expiresAt } = raw;
  if (!isHostId(hostId) || !isSpawnId(spawnId) || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  if (typeof agent !== 'string' || typeof rootId !== 'string' || !isIsoString(receivedAt) || !isIsoString(expiresAt)) return null;
  if (state === 'pending') {
    const request = parseSpawnRequest(raw['request']);
    if (!request || request.spawnId !== spawnId) return null;
    return { v: 1, hostId, spawnId, fingerprint, agent: request.agent, rootId: request.folder.root, state, receivedAt, expiresAt, request };
  }
  if (state !== 'decided' || !isSpawnCode(code)) return null;
  const decidedAt = isIsoString(raw['decidedAt']) ? raw['decidedAt'] : receivedAt;
  return {
    v: 1, hostId, spawnId, fingerprint, agent: agent as A2aSpawnRequestV1['agent'], rootId, state, code, receivedAt, expiresAt, decidedAt,
    ...(raw['sent'] === true ? { sent: true as const } : {}),
  };
}
