// This host's cross-host A2A identity: a stable hostId plus the self-signed
// TLS certificate the A2A listener serves.
//
//   <dir>/host.json          { v: 1, hostId, createdAt } — created once (exclusive), never rewritten
//   <dir>/cert.json          { v: 1, gen }               — pointer to the active certificate generation
//   <dir>/cert-<gen>.pem     self-signed certificate     — write-once
//   <dir>/key-<gen>.pem      PKCS#8 P-256 private key    — write-once, owner-only
//
// The certificate is disposable: it is re-issued only when the active pair is
// missing, unparseable, mismatched, fails its self-signature, or is within
// HOST_CERT_RENEW_BEFORE_DAYS of expiry. Joiners pin the FINGERPRINT, so a
// re-issue forces every joiner to re-pin; that is why a changed hostname or IP
// does NOT re-issue (the SAN is informational, written at issue time). The
// hostId survives every re-issue: links are bound to it (contract `HostId`).
//
// A new generation is written under fresh file names and fsynced, and only
// then does cert.json flip to it. That rename is the single switch point, so a
// failure at any step leaves the previous pair active and intact.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { A2A_REMOTE_RECORD_V, isHostId, type CertFingerprint256, type HostId } from '../../shared/a2aRemote';
import { secureWriteTokenFile } from '../../shared/security';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { generateSelfSignedCert, isSanDnsName } from './selfSignedCert';

/**
 * Long on purpose: nothing publicly trusts this certificate (joiners pin its
 * fingerprint), and every re-issue forces every joiner to re-pin.
 */
export const HOST_CERT_VALID_DAYS = 3650;
/** Re-issue when fewer than this many days of validity remain. */
export const HOST_CERT_RENEW_BEFORE_DAYS = 30;
/** A lock older than this belongs to a crashed issuer (issuing takes milliseconds). */
export const ISSUE_LOCK_STALE_MS = 30_000;
const ISSUE_LOCK_WAIT_MS = 10_000;

const DAY_MS = 86_400_000;
const HOST_FILE = 'host.json';
const POINTER_FILE = 'cert.json';
const LOCK_FILE = 'issue.lock';
const GEN_RE = /^[0-9a-z]{1,16}-[0-9a-f]{8}$/;
const GEN_FILE_RE = /^(?:cert|key)-(.+)\.pem$/;

interface HostRecordV1 {
  v: 1;
  hostId: HostId;
  createdAt: string;
}

interface CertPointerV1 {
  v: 1;
  gen: string;
}

export interface HostIdentityOptions {
  /** Directory holding the identity files (created if absent). */
  dir: string;
  /** This machine's name; goes in the CN and, when a valid ASCII host name, a SAN dNSName. Informational. */
  hostname: string;
  /** This machine's LAN addresses at issue time. Only canonical IPv4 goes in the SAN; others are ignored. */
  ipAddresses: string[];
  now?: Date;
}

export interface HostIdentity {
  hostId: HostId;
  /** Paths of the ACTIVE generation. */
  certPath: string;
  keyPath: string;
  fingerprint256: CertFingerprint256;
  notAfter: string;
  /** True when this call issued a new certificate, i.e. the fingerprint changed. */
  created: boolean;
}

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/** Read a file; null on ENOENT, any other I/O error (EACCES/EBUSY/EPERM…) throws. */
function readOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Create `file` with `content`, fsynced, failing with EEXIST if it already exists. */
function writeNewFileDurably(file: string, content: string, mode: number): void {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** host.json → hostId; null when absent. Present-but-invalid THROWS (fail closed). */
function readHostId(file: string): HostId | null {
  const raw = readOrNull(file);
  if (raw === null) return null;
  let rec: Partial<HostRecordV1> | null = null;
  try {
    rec = JSON.parse(raw.toString('utf8')) as Partial<HostRecordV1> | null;
  } catch {
    /* corrupt → below */
  }
  if (!rec || typeof rec !== 'object' || rec.v !== A2A_REMOTE_RECORD_V || !isHostId(rec.hostId)) {
    throw new Error(`A2A host identity file is corrupt; refusing to mint a new hostId: ${file}`);
  }
  return rec.hostId;
}

function hasCertificateState(dir: string): boolean {
  return fs.existsSync(path.join(dir, POINTER_FILE)) || fs.readdirSync(dir).some((n) => GEN_FILE_RE.test(n));
}

/**
 * Read host.json, or mint it on a fresh directory. Corrupt → throws; missing
 * beside existing certificate state (a partially lost identity, not a fresh
 * install) → throws. A new hostId would silently invalidate every link.
 *
 * Minting is race-free across processes: the record is written to a private
 * temp file, fsynced, then hard-linked into place. link(2) fails with EEXIST
 * when another process won, and a reader can never observe a half-written
 * host.json. The loser re-reads the winner's record.
 */
function loadOrMintHostId(dir: string, now: Date): HostId {
  const file = path.join(dir, HOST_FILE);
  const existing = readHostId(file);
  if (existing) return existing;
  if (hasCertificateState(dir)) {
    // Another process may have minted and issued in the meantime (it always
    // writes host.json first); only a still-missing host.json is a lost identity.
    const raced = readHostId(file);
    if (raced) return raced;
    throw new Error(`A2A host identity file is missing beside an existing certificate; refusing to mint a new hostId: ${file}`);
  }
  const record: HostRecordV1 = { v: A2A_REMOTE_RECORD_V, hostId: crypto.randomUUID(), createdAt: now.toISOString() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    writeNewFileDurably(tmp, JSON.stringify(record, null, 2), 0o600);
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
  } finally {
    unlinkQuietly(tmp);
  }
  const winner = readHostId(file);
  if (!winner) throw new Error(`A2A host identity file vanished right after creation: ${file}`);
  return winner;
}

/** cert.json → active generation; null when absent or unusable (→ re-issue). */
function readActiveGen(dir: string): string | null {
  const file = path.join(dir, POINTER_FILE);
  // atomicWriteJSONSync moves the old pointer to .bak just before committing
  // the new one; a crash in that gap leaves only .bak, which still names a
  // complete generation (old generations are removed only after the flip).
  const raw = readOrNull(file) ?? readOrNull(`${file}.bak`);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw.toString('utf8')) as Partial<CertPointerV1> | null;
    return p && p.v === A2A_REMOTE_RECORD_V && typeof p.gen === 'string' && GEN_RE.test(p.gen) ? p.gen : null;
  } catch {
    return null;
  }
}

const genPaths = (dir: string, gen: string) => ({
  certPath: path.join(dir, `cert-${gen}.pem`),
  keyPath: path.join(dir, `key-${gen}.pem`),
});

/**
 * Load the active pair. null (→ re-issue) only when a file is absent, does not
 * parse, the key does not belong to the certificate, or the self-signature
 * does not verify. Any other I/O error throws: a file an AV scanner holds open
 * on Windows is not a reason to rotate the fingerprint.
 */
function tryLoadActive(dir: string): { gen: string; cert: crypto.X509Certificate } | null {
  const gen = readActiveGen(dir);
  if (!gen) return null;
  const { certPath, keyPath } = genPaths(dir, gen);
  const certPem = readOrNull(certPath);
  const keyPem = readOrNull(keyPath);
  if (certPem === null || keyPem === null) return null;
  try {
    const cert = new crypto.X509Certificate(certPem);
    const key = crypto.createPrivateKey(keyPem);
    return cert.checkPrivateKey(key) && cert.verify(cert.publicKey) ? { gen, cert } : null;
  } catch {
    return null;
  }
}

const isFresh = (cert: crypto.X509Certificate, now: Date): boolean =>
  Date.parse(cert.validTo) - now.getTime() > HOST_CERT_RENEW_BEFORE_DAYS * DAY_MS;

/**
 * POSIX: repair a key loosened after the fact (restore from backup, manual
 * chmod). Windows: `secureWriteTokenFile` created the key through a fresh inode
 * whose DACL was set owner-only (inheritance stripped) before the payload
 * landed, and key files are write-once, so that DACL is the one the key has.
 */
function hardenKeyMode(keyPath: string): void {
  if (process.platform === 'win32') return;
  if ((fs.statSync(keyPath).mode & 0o077) !== 0) fs.chmodSync(keyPath, 0o600);
}

/** What a lock file holds, read through ONE descriptor so content and mtime describe the same file. */
export interface IssueLockState {
  /** Short hash of the content (each holder writes a unique token; a crashed create leaves it empty). */
  key: string;
  mtimeMs: number;
}

const lockKey = (content: Buffer): string => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

export function readIssueLockState(lock: string): IssueLockState | null {
  let fd: number;
  try {
    fd = fs.openSync(lock, 'r');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
  try {
    const { mtimeMs } = fs.fstatSync(fd);
    return { key: lockKey(fs.readFileSync(fd)), mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

const isStaleLock = (s: IssueLockState): boolean => Date.now() - s.mtimeMs > ISSUE_LOCK_STALE_MS;

/**
 * Windows: a lock or takeover marker another process just unlinked stays
 * "delete pending" while any handle to it is still open (a waiter's
 * readIssueLockState, the holder's release read). Until the last handle
 * closes, opening or exclusive-creating that name fails EPERM (EACCES/EBUSY
 * from some filters) instead of ENOENT or EEXIST. That is the lock changing
 * hands, not a fault: callers treat it as "held right now" and retry within
 * their deadline. POSIX has no such state, so there it stays an error.
 */
export function isLockInTransition(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const code = errCode(err);
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Remove the stale lock a waiter observed (`seenKey`), at most once across all
 * waiters, and never a lock that replaced it. Every waiter that saw the same
 * stale lock races to exclusive-create a marker named after its key; exactly
 * one wins, re-reads the lock, and removes it only if it is STILL that stale
 * content. A waiter that arrives late finds either no lock or a fresh holder's
 * lock (different key, or not stale) and touches nothing. Only the marker
 * owner ever removes a stale lock, so the lock cannot change between that
 * re-read and the unlink. Returns true when this call removed the lock.
 */
export function breakStaleIssueLock(lock: string, seenKey: string): boolean {
  const marker = `${lock}.takeover-${seenKey}`;
  try {
    fs.writeFileSync(marker, '', { flag: 'wx' });
  } catch (err) {
    // Another breaker's marker for this key is being removed: it already ran.
    if (isLockInTransition(err)) return false;
    if (errCode(err) !== 'EEXIST') throw err;
    // A breaker that crashed between claim and release must not block this key forever.
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs > ISSUE_LOCK_STALE_MS) unlinkQuietly(marker);
    } catch {
      /* gone already */
    }
    return false;
  }
  try {
    let current: IssueLockState | null;
    try {
      current = readIssueLockState(lock);
    } catch (err) {
      if (isLockInTransition(err)) return false; // the stale lock is already being removed
      throw err;
    }
    if (!current || current.key !== seenKey || !isStaleLock(current)) return false;
    try {
      fs.unlinkSync(lock);
      return true;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return false;
      throw err;
    }
  } finally {
    unlinkQuietly(marker);
  }
}

/** readIssueLockState, with a Windows delete-pending lock read as absent. */
function readLockUnlessInTransition(lock: string): IssueLockState | null {
  try {
    return readIssueLockState(lock);
  } catch (err) {
    if (isLockInTransition(err)) return null;
    throw err;
  }
}

/** Cross-process mutex around (re-)issuing: exclusive-create lock file with race-free stale takeover. */
function withIssueLock<T>(dir: string, fn: () => T): T {
  const lock = path.join(dir, LOCK_FILE);
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + ISSUE_LOCK_WAIT_MS;
  const waitOrGiveUp = (): void => {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the A2A certificate lock: ${lock}`);
    sleepSync(20);
  };
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      break;
    } catch (err) {
      // Windows: the previous holder's lock is still delete-pending. Held, for our purposes.
      if (isLockInTransition(err)) {
        waitOrGiveUp();
        continue;
      }
      if (errCode(err) !== 'EEXIST') throw err;
    }
    let seen: IssueLockState | null;
    try {
      seen = readIssueLockState(lock);
    } catch (err) {
      if (!isLockInTransition(err)) throw err;
      waitOrGiveUp(); // being released right now; the next create decides
      continue;
    }
    if (!seen) continue; // released between our attempts
    // Holder crashed mid-issue: the one waiter that breaks it retries the
    // exclusive create at once; everyone else keeps waiting.
    if (isStaleLock(seen) && breakStaleIssueLock(lock, seen.key)) continue;
    waitOrGiveUp();
  }
  try {
    return fn();
  } finally {
    // Release only our own lock, never one that replaced it. A lock we cannot
    // read because it is delete-pending is not ours any more: leave it.
    if (readLockUnlessInTransition(lock)?.key === lockKey(Buffer.from(token))) unlinkQuietly(lock);
  }
}

/**
 * Remove every generation other than the one the pointer names NOW (re-read,
 * not assumed to be ours). Skipped when the pointer is unreadable. Failure is
 * harmless: the pointer decides which pair is used.
 */
function removeInactiveGenerations(dir: string): void {
  const active = readActiveGen(dir);
  if (!active) return;
  for (const name of fs.readdirSync(dir)) {
    const m = GEN_FILE_RE.exec(name);
    if (m && m[1] !== active) unlinkQuietly(path.join(dir, name));
  }
}

const isCanonicalIpv4 = (ip: string): boolean => net.isIPv4(ip) && ip.split('.').map(Number).join('.') === ip;

function issue(dir: string, opts: HostIdentityOptions, now: Date): { gen: string; fingerprint256: string; notAfter: string } {
  const hostname = opts.hostname.trim();
  const cert = generateSelfSignedCert({
    // Cut by code point so a surrogate pair is never split.
    commonName: Array.from(hostname).slice(0, 64).join('') || 'wmux',
    dnsNames: isSanDnsName(hostname) ? [hostname.toLowerCase()] : [],
    ipAddresses: [...new Set(opts.ipAddresses.filter(isCanonicalIpv4))],
    validDays: HOST_CERT_VALID_DAYS,
    now,
  });
  const gen = `${now.getTime().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const { certPath, keyPath } = genPaths(dir, gen);
  try {
    secureWriteTokenFile(keyPath, cert.keyPem);
    fsyncFile(keyPath);
    writeNewFileDurably(certPath, cert.certPem, 0o644);
    // The switch point. Before it commits, the previous generation stays active.
    atomicWriteJSONSync(path.join(dir, POINTER_FILE), { v: A2A_REMOTE_RECORD_V, gen } satisfies CertPointerV1, {
      durable: true,
    });
  } catch (err) {
    unlinkQuietly(certPath);
    unlinkQuietly(keyPath);
    throw err;
  }
  removeInactiveGenerations(dir);
  return { gen, fingerprint256: cert.fingerprint256, notAfter: cert.notAfter };
}

export function loadOrCreateHostIdentity(opts: HostIdentityOptions): HostIdentity {
  const now = opts.now ?? new Date();
  const dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });
  const hostId = loadOrMintHostId(dir, now);

  const reuse = (active: { gen: string; cert: crypto.X509Certificate }): HostIdentity => {
    const paths = genPaths(dir, active.gen);
    hardenKeyMode(paths.keyPath);
    return {
      hostId,
      ...paths,
      fingerprint256: active.cert.fingerprint256,
      notAfter: new Date(active.cert.validTo).toISOString(),
      created: false,
    };
  };

  const active = tryLoadActive(dir);
  if (active && isFresh(active.cert, now)) return reuse(active);

  return withIssueLock(dir, () => {
    // Another process may have issued while we waited for the lock.
    const current = tryLoadActive(dir);
    if (current && isFresh(current.cert, now)) return reuse(current);
    const issued = issue(dir, opts, now);
    return {
      hostId,
      ...genPaths(dir, issued.gen),
      fingerprint256: issued.fingerprint256,
      notAfter: issued.notAfter,
      created: true,
    };
  });
}
