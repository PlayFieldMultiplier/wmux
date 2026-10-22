// ─── Image files of cross-PC A2A messages (`images.1`) ─────────────────────
//
// Four folders, each owned by this store, 0700, files 0600, written to a
// temp name with `wx` and renamed into place:
//
//   <wmuxDir>/uploads/a2a/<hostId>/<sha256>.<ext>  images received from that
//       PC: what the receiving agent reads by path. Content-addressed, so a
//       message received twice writes nothing new (the file's time is
//       refreshed instead). Kept A2A_IMAGE_RETAIN_MS by mtime.
//   <wmuxDir>/uploads/a2a/local/<sha256>.<ext>  images an agent on THIS PC
//       sent to another pane here (a2a.attachments.stage), same retention.
//   <wmuxDir>/a2a/blobs/<sha256>  the sender's copy of what it queued for
//       another PC: the bytes the envelope's hash names, kept while a ledger
//       message still refers to them (the outbound sync may rebuild an
//       envelope from the ledger at any time), served to a joiner by GET.
//   <wmuxDir>/a2a/blobs-in/<hostId>/<sha256>  bytes a joiner uploaded (PUT)
//       ahead of the envelope that names them. Moved into the received
//       folder once that envelope passes the link checks; dropped when the
//       envelope is refused for good, when the peer's share is full (its own
//       oldest go first) and after STAGING_TTL_MS.
//
// The `uploads/a2a` folder is inside `~/.wmux/uploads`, the folder
// `browser_file_upload` already allows, as the phone's photos are. Nothing in
// these folders is ever opened, decoded or run by wmux; an extension comes
// from the sniffed bytes only and no name from a peer ever reaches a path.
// The sweeps match only the names this store writes.
//
// Quotas: one PC's received folder holds at most RECEIVED_HOST_MAX_FILES /
// RECEIVED_HOST_MAX_BYTES, all of `uploads/a2a` at most
// RECEIVED_TOTAL_MAX_BYTES. A full store refuses (the image is reported as
// not received); it never evicts a received image. Paired PCs can fill the
// total between them: it is bounded, and the retention frees it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { A2A_REMOTE_IMAGE_LIMITS, A2A_SHA256_RE, isHostId, type A2aRemoteImageMediaType, type A2aRemoteImageRef, type HostId } from '../../shared/a2aRemote';
import { inspectA2aImage, type A2aImageInfo } from '../../shared/a2aImages';

const DAY_MS = 24 * 3600_000;
/** How long a received (or locally sent) image file stays: a held task may wait days for a person. */
export const A2A_IMAGE_RETAIN_MS = 7 * DAY_MS;
/** An upload no envelope claimed within this long is dropped. */
export const STAGING_TTL_MS = 3600_000;
/** One peer's staging share (two full messages). */
export const STAGING_PEER_MAX_BYTES = 20 * 1024 * 1024;
export const RECEIVED_HOST_MAX_FILES = 100;
export const RECEIVED_HOST_MAX_BYTES = 200 * 1024 * 1024;
export const RECEIVED_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
/** A sender copy no ledger message refers to is dropped after this long. */
const OUTGOING_GRACE_MS = 3600_000;

export const LOCAL_FOLDER = 'local';
const STORED_RE = /^([0-9a-f]{64})\.(png|jpg|webp)$/;
const BLOB_RE = /^[0-9a-f]{64}$/;
const TEMP_RE = /^\.[0-9a-f]{64}\.[0-9a-f]{8}\.part$/;

const EXT: Record<A2aRemoteImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type ImageNotReceived = 'missing' | 'invalid' | 'full';

export type StoredImage = { ok: true; path: string; info: A2aImageInfo; created?: true } | { ok: false; reason: ImageNotReceived };

export interface A2aImageStoreOptions {
  /** `<wmuxDir>/a2a` */
  a2aDir: string;
  /** `<wmuxDir>/uploads` */
  uploadsRoot: string;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Bytes match a ref: exact size, hash, and a well-formed image of the named type. */
export function checkImageBytes(ref: A2aRemoteImageRef, bytes: Buffer): A2aImageInfo | null {
  if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) return null;
  const check = inspectA2aImage(bytes);
  return check.ok && check.info.mediaType === ref.mediaType ? check.info : null;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export class A2aImageStore {
  private readonly opts: A2aImageStoreOptions;
  private readonly now: () => number;

  constructor(opts: A2aImageStoreOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** `uploads/a2a` */
  get root(): string {
    return path.join(this.opts.uploadsRoot, 'a2a');
  }

  get uploadsRoot(): string {
    return this.opts.uploadsRoot;
  }

  // --- sender ---------------------------------------------------------------

  /** Keep the bytes this PC queued for another PC. */
  async putOutgoing(bytes: Buffer): Promise<string> {
    const sha = sha256(bytes);
    await this.outgoing(() => this.writeOnce(this.outgoingDir(), sha, bytes));
    return sha;
  }

  /** Where the sender copy of `sha` is kept. */
  outgoingPath(sha: string): string {
    return path.join(this.outgoingDir(), sha);
  }

  /** The sender copy, or null (swept, never written). */
  async readOutgoing(sha: string): Promise<Buffer | null> {
    if (!A2A_SHA256_RE.test(sha)) return null;
    return readRegular(path.join(this.outgoingDir(), sha));
  }

  /**
   * Drop sender copies no ledger message or open record (`referenced`, read
   * fresh) refers to, past a grace period. Each one is looked at again just
   * before it goes: a send that reused it since the listing (its time
   * refreshed, or now referenced) keeps it.
   */
  async gcOutgoing(referenced: () => ReadonlySet<string>): Promise<number> {
    // One at a time with putOutgoing: a copy being written is never swept under it.
    return this.outgoing(() => this.sweepOutgoing(referenced));
  }

  private async sweepOutgoing(referenced: () => ReadonlySet<string>): Promise<number> {
    let dropped = 0;
    const cutoff = this.now() - OUTGOING_GRACE_MS;
    const listed = referenced();
    for (const { name, full, st } of await listFiles(this.outgoingDir())) {
      if (TEMP_RE.test(name) && st.mtimeMs < cutoff) await unlinkQuiet(full);
      if (!BLOB_RE.test(name) || listed.has(name) || st.mtimeMs >= cutoff) continue;
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      const now = await lstatOrNull(full);
      if (!now || now.mtimeMs >= cutoff || referenced().has(name)) continue;
      if (await unlinkQuiet(full)) dropped += 1;
    }
    return dropped;
  }

  /**
   * Keep an image an agent sent to a pane on this PC; its path is what the
   * receiver reads. This folder is this PC's own, so when it is full its
   * oldest files that nothing still open refers to (`inUse`) make room.
   */
  async putLocal(bytes: Buffer, info: A2aImageInfo, inUse: (sha: string) => boolean): Promise<StoredImage> {
    const ref: A2aRemoteImageRef = { sha256: sha256(bytes), mediaType: info.mediaType, bytes: bytes.length };
    // One at a time with every other write and sweep there: a copy another
    // call just found or wrote is never evicted under it.
    return this.incoming(async () => {
      const existing = await this.findReceived(LOCAL_FOLDER, ref);
      if (existing) return existing;
      await this.evictLocal(bytes.length, inUse);
      const stored = await this.keepReceived(LOCAL_FOLDER, ref, bytes);
      return stored.ok ? { ...stored, created: true } : stored;
    });
  }

  /** Remove the local copy of `sha` (whatever its type), one this PC just wrote; whether one was there. */
  async discardLocal(sha: string): Promise<boolean> {
    if (!A2A_SHA256_RE.test(sha)) return false;
    return this.incoming(async () => {
      let removed = false;
      for (const ext of Object.values(EXT)) {
        // eslint-disable-next-line no-await-in-loop -- three names at most
        if (await unlinkQuiet(path.join(this.root, LOCAL_FOLDER, `${sha}.${ext}`))) removed = true;
      }
      return removed;
    });
  }

  /**
   * Remove local copies nothing open refers to, oldest first, until
   * `incoming` more bytes fit. When even removing all of them would not make
   * it fit (the rest of the store is full), nothing is removed: the send is
   * refused as full either way.
   */
  private async evictLocal(incoming: number, inUse: (sha: string) => boolean): Promise<void> {
    await this.sweepReceived();
    const dir = path.join(this.root, LOCAL_FOLDER);
    const held = (await listFiles(dir)).filter((f) => STORED_RE.test(f.name)).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    let files = held.length;
    let bytes = held.reduce((n, f) => n + f.st.size, 0);
    let total = await this.measureAll();
    const fits = (): boolean =>
      files + 1 <= RECEIVED_HOST_MAX_FILES && bytes + incoming <= RECEIVED_HOST_MAX_BYTES && total + incoming <= RECEIVED_TOTAL_MAX_BYTES;
    if (fits()) return;
    const removable = held.filter((f) => !inUse(f.name.slice(0, 64)));
    const freed = removable.reduce((n, f) => n + f.st.size, 0);
    const best = { files: files - removable.length, bytes: bytes - freed, total: total - freed };
    if (!(best.files + 1 <= RECEIVED_HOST_MAX_FILES && best.bytes + incoming <= RECEIVED_HOST_MAX_BYTES && best.total + incoming <= RECEIVED_TOTAL_MAX_BYTES)) return;
    for (const f of removable) {
      if (fits()) return;
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      if (!(await unlinkQuiet(f.full))) continue;
      files -= 1;
      bytes -= f.st.size;
      total -= f.st.size;
    }
  }

  // --- server: uploads from a joiner ----------------------------------------

  /**
   * Whether `hostId`'s image is here already with these exact bytes, uploaded
   * or received (a PUT then needs no body). A hit refreshes the file's time,
   * so an upload a resend still needs is not the oldest one a full share drops.
   */
  async has(hostId: HostId, sha: string): Promise<boolean> {
    if (!isHostId(hostId) || !A2A_SHA256_RE.test(sha)) return false;
    const candidates = [path.join(this.stagingDir(hostId), sha), ...Object.values(EXT).map((ext) => path.join(this.root, hostId, `${sha}.${ext}`))];
    // In line with the sweeps: a file whose time this refreshes is not then swept from an older listing.
    return this.incoming(async () => {
      for (const full of candidates) {
        // eslint-disable-next-line no-await-in-loop -- at most four small checks
        if (await this.holds(full, sha)) return true;
      }
      return false;
    });
  }

  /**
   * Whether a file under `sha` is here for `hostId` (uploaded or received),
   * by name and size only: no read, no hash, no time refreshed (a question
   * is not a use). The bytes are checked when an envelope claims them.
   */
  async mayHave(hostId: HostId, sha: string): Promise<boolean> {
    if (!isHostId(hostId) || !A2A_SHA256_RE.test(sha)) return false;
    const candidates = [path.join(this.stagingDir(hostId), sha), ...Object.values(EXT).map((ext) => path.join(this.root, hostId, `${sha}.${ext}`))];
    for (const full of candidates) {
      // eslint-disable-next-line no-await-in-loop -- at most four stats
      const st = await lstatOrNull(full);
      if (st?.isFile() && st.size > 0 && st.size <= A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES) return true;
    }
    return false;
  }

  /**
   * Keep an upload until its envelope comes. The bytes are a well-formed
   * image under that hash (checked by the caller). Over the peer's share,
   * its own oldest uploads go first; one upload never exceeds the share.
   */
  async stage(hostId: HostId, sha: string, bytes: Buffer): Promise<void> {
    if (!isHostId(hostId) || !A2A_SHA256_RE.test(sha)) throw new Error('a2a images: bad staging key');
    const dir = this.stagingDir(hostId);
    // The share is measured and made room in with no other upload landing in between.
    await this.incoming(async () => {
      const held = (await listFiles(dir)).filter((f) => BLOB_RE.test(f.name)).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
      let total = held.reduce((n, f) => n + f.st.size, 0);
      for (const f of held) {
        if (total + bytes.length <= STAGING_PEER_MAX_BYTES) break;
        if (await unlinkQuiet(f.full)) total -= f.st.size;
      }
      await this.writeOnce(dir, sha, bytes);
    });
  }

  /** An envelope from `hostId` passed the link checks: move its upload into the received folder. */
  async claim(hostId: HostId, ref: A2aRemoteImageRef): Promise<StoredImage> {
    // Checked before any path is built: a name that is not a host id never reaches the file system.
    if (!isHostId(hostId) || !A2A_SHA256_RE.test(ref.sha256)) return { ok: false, reason: 'invalid' };
    return this.incoming(async () => {
      const existing = await this.findReceived(hostId, ref);
      if (existing) return existing;
      const staged = path.join(this.stagingDir(hostId), ref.sha256);
      const bytes = await readRegular(staged);
      if (!bytes) return { ok: false, reason: 'missing' };
      const stored = await this.keepReceived(hostId, ref, bytes);
      if (stored.ok || stored.reason === 'invalid') await unlinkQuiet(staged);
      return stored;
    });
  }

  /** The envelope naming these uploads was refused for good: they will never be claimed. */
  async discardStaged(hostId: HostId, refs: readonly A2aRemoteImageRef[]): Promise<void> {
    if (!isHostId(hostId)) return;
    await this.incoming(async () => {
      for (const ref of refs) if (A2A_SHA256_RE.test(ref.sha256)) await unlinkQuiet(path.join(this.stagingDir(hostId), ref.sha256));
    });
  }

  // --- receiver -------------------------------------------------------------

  /**
   * The received file for `ref`, when it is here with exactly its bytes (its
   * time refreshed). A file under that name with other bytes (something
   * rewrote it) is removed, so the image is taken again instead of standing
   * for content it no longer holds.
   */
  async received(folder: string, ref: A2aRemoteImageRef): Promise<StoredImage | null> {
    return this.incoming(() => this.findReceived(folder, ref));
  }

  /** Check and keep received bytes under the receiver's own name. */
  async storeReceived(folder: string, ref: A2aRemoteImageRef, bytes: Buffer): Promise<StoredImage> {
    return this.incoming(() => this.keepReceived(folder, ref, bytes));
  }

  // The two above, run inside `incoming` (they never queue again).

  private async findReceived(folder: string, ref: A2aRemoteImageRef): Promise<StoredImage | null> {
    if (!this.validFolder(folder) || !A2A_SHA256_RE.test(ref.sha256)) return null;
    const full = path.join(this.root, folder, `${ref.sha256}.${EXT[ref.mediaType]}`);
    const bytes = await readRegular(full);
    if (!bytes) return null;
    const info = checkImageBytes(ref, bytes);
    if (!info) {
      await unlinkQuiet(full);
      return null;
    }
    const t = new Date(this.now());
    await fs.promises.utimes(full, t, t).catch(() => undefined);
    return { ok: true, path: full, info };
  }

  private async keepReceived(folder: string, ref: A2aRemoteImageRef, bytes: Buffer): Promise<StoredImage> {
    if (!this.validFolder(folder)) return { ok: false, reason: 'invalid' };
    const info = checkImageBytes(ref, bytes);
    if (!info) return { ok: false, reason: 'invalid' };
    const existing = await this.findReceived(folder, ref);
    if (existing) return existing;
    await this.sweepReceived();
    const hostHeld = await measure(path.join(this.root, folder));
    const totalHeld = await this.measureAll();
    if (
      hostHeld.files + 1 > RECEIVED_HOST_MAX_FILES ||
      hostHeld.bytes + bytes.length > RECEIVED_HOST_MAX_BYTES ||
      totalHeld + bytes.length > RECEIVED_TOTAL_MAX_BYTES
    ) {
      return { ok: false, reason: 'full' };
    }
    const name = `${ref.sha256}.${EXT[ref.mediaType]}`;
    try {
      await this.writeOnce(path.join(this.root, folder), name, bytes);
    } catch (err) {
      this.opts.log?.('warn', `[a2a-remote] an image was not stored: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'full' };
    }
    return { ok: true, path: path.join(this.root, folder, name), info };
  }

  // --- upkeep ---------------------------------------------------------------

  /** Drop received images past the retention, stale temp files and unclaimed uploads. */
  async sweep(): Promise<void> {
    // One at a time with the writes and time refreshes there: an upload a
    // resend just refreshed (`has`) is not dropped from an older listing.
    await this.incoming(async () => {
      await this.sweepReceived();
      const cutoff = this.now() - STAGING_TTL_MS;
      for (const host of await listDirs(path.join(this.opts.a2aDir, 'blobs-in'))) {
        for (const f of await listFiles(host)) {
          if ((BLOB_RE.test(f.name) || TEMP_RE.test(f.name)) && f.st.mtimeMs < cutoff) await unlinkQuiet(f.full);
        }
      }
    });
  }

  private async sweepReceived(): Promise<void> {
    const cutoff = this.now() - A2A_IMAGE_RETAIN_MS;
    const tempCutoff = this.now() - STAGING_TTL_MS;
    for (const dir of await listDirs(this.root)) {
      if (!this.validFolder(path.basename(dir))) continue;
      for (const f of await listFiles(dir)) {
        if ((STORED_RE.test(f.name) && f.st.mtimeMs < cutoff) || (TEMP_RE.test(f.name) && f.st.mtimeMs < tempCutoff)) await unlinkQuiet(f.full);
      }
    }
  }

  private async measureAll(): Promise<number> {
    let bytes = 0;
    for (const dir of await listDirs(this.root)) {
      if (this.validFolder(path.basename(dir))) bytes += (await measure(dir)).bytes;
    }
    return bytes;
  }

  // --- internals ------------------------------------------------------------

  /** Sender copies: every write and sweep there, one at a time. */
  private readonly outgoing = serial();
  /**
   * The received and staging folders: every write, time refresh, eviction
   * and sweep there, one at a time. Only file work runs inside, never a
   * transfer, and nothing inside queues again.
   */
  private readonly incoming = serial();

  private outgoingDir(): string {
    return path.join(this.opts.a2aDir, 'blobs');
  }

  private stagingDir(hostId: HostId): string {
    return path.join(this.opts.a2aDir, 'blobs-in', hostId);
  }

  private validFolder(folder: string): boolean {
    return folder === LOCAL_FOLDER || isHostId(folder);
  }

  /** `full` is a regular file whose bytes hash to `sha` (its time is refreshed). */
  private async holds(full: string, sha: string): Promise<boolean> {
    const bytes = await readRegular(full);
    if (!bytes || sha256(bytes) !== sha) return false;
    const t = new Date(this.now());
    await fs.promises.utimes(full, t, t).catch(() => undefined);
    return true;
  }

  /**
   * Write `name` in `dir` (its content's hash is the name's first 64 hex),
   * unless a regular file with those bytes is there already; temp + rename,
   * 0600. A file under the name with other bytes is replaced.
   */
  private async writeOnce(dir: string, name: string, bytes: Buffer): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const final = path.join(dir, name);
    const sha = name.slice(0, 64);
    if (await this.holds(final, sha)) return;
    const temp = path.join(dir, `.${sha}.${crypto.randomBytes(4).toString('hex')}.part`);
    try {
      await fs.promises.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temp, final);
    } catch (err) {
      await unlinkQuiet(temp);
      // A concurrent write of the same content can win the rename (Windows
      // fails one on a sharing violation): the name then holds these bytes.
      if (await this.holds(final, sha)) return;
      throw err;
    }
  }
}

/** Run each `fn` after every earlier one has settled; one that fails does not stop the ones after it. */
function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
}

// --- fs helpers ---------------------------------------------------------------

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p);
  } catch {
    return null;
  }
}

/** A regular file's bytes (never through a link), or null. */
async function readRegular(p: string): Promise<Buffer | null> {
  try {
    const st = await fs.promises.lstat(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return await fs.promises.readFile(p);
  } catch {
    return null;
  }
}

async function listFiles(dir: string): Promise<Array<{ name: string; full: string; st: fs.Stats }>> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; full: string; st: fs.Stats }> = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(full);
      if (st.isFile()) out.push({ name, full, st });
    } catch {
      // vanished between readdir and lstat
    }
  }
  return out;
}

async function listDirs(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

/** Files and bytes this store wrote in `dir` (other names are not ours to count). */
async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const f of await listFiles(dir)) {
    if (!STORED_RE.test(f.name)) continue;
    files += 1;
    bytes += f.st.size;
  }
  return { files, bytes };
}

async function unlinkQuiet(p: string): Promise<boolean> {
  try {
    await fs.promises.unlink(p);
    return true;
  } catch {
    return false;
  }
}
