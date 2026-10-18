// ─── Task worktree removals that have not finished (#2388) ─────────────────
//
// A task close records its worktree here before anything is stopped or
// removed, and forgets it once the folder is gone. When `git worktree remove`
// drops the worktree's record but leaves part of the folder (a file still
// held open on Windows) and the leftover could not be finished at once, the
// record is what is left: the folder is no longer a worktree, so the task's
// next close could not tell which repository it came from and would close the
// task around it. With the record, that close (and the sweep at start,
// TaskWorktreeManager.finishPendingRemoval) finishes the removal under the
// same checks as the first attempt. Persisted as
// `<wmuxDir>/worktask/pending-removals.json`.

import fs from 'node:fs';
import path from 'node:path';
import { createFilePersister, readVersionedFile, type FilePersister } from '../factory/versionedFile';
import { sessionHostDir } from './stopSessionsInDir';

export const PENDING_REMOVALS_FILENAME = 'pending-removals.json';
export const PENDING_REMOVALS_VERSION = 1 as const;
/** Records kept (oldest dropped first). */
export const PENDING_REMOVALS_MAX = 500;

export interface PendingWorktreeRemoval {
  /** The worktree folder, as the removal named it (absolute). */
  path: string;
  repoRoot: string;
  repoHash: string;
  /** The commit the worktree had checked out when it was found clean: what a
   *  leftover folder is compared with before it is deleted. */
  head?: string;
  /** Close and keep folder was chosen: the folder is never deleted, the
   *  lock is off, and the record waits only for its task's detached close
   *  to be confirmed (a close that failed is kept again by the next one). */
  keep?: true;
  at: number;
}

function isRecord(v: unknown): v is PendingWorktreeRemoval {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.path === 'string' && path.isAbsolute(r.path) && typeof r.repoRoot === 'string' && typeof r.repoHash === 'string'
    && (r.head === undefined || (typeof r.head === 'string' && /^[0-9a-f]{40,64}$/.test(r.head)))
    && (r.keep === undefined || r.keep === true)
    && typeof r.at === 'number';
}

/** The key of a folder: resolved, compared without case on Windows and macOS. */
export function pendingRemovalKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export interface PendingRemovalStore {
  /** Why the file could not be read, when it could not: nothing it holds is
   *  known, so nothing can be dropped from it either. */
  unreadable?(): string | null;
  get(worktreePath: string): PendingWorktreeRemoval | null;
  all(): PendingWorktreeRemoval[];
  put(rec: PendingWorktreeRemoval): Promise<void>;
  delete(worktreePath: string): Promise<void>;
}

export class PendingWorktreeRemovals implements PendingRemovalStore {
  private readonly records = new Map<string, PendingWorktreeRemoval>();
  private readonly persister: FilePersister;
  /** Set when load() failed: the file is left as it is (never overwritten). */
  private loadError: string | null = null;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: PENDING_REMOVALS_VERSION, removals: [...this.records.values()] }));
  }

  static at(wmuxDir: string): PendingWorktreeRemovals {
    return new PendingWorktreeRemovals(path.join(wmuxDir, 'worktask', PENDING_REMOVALS_FILENAME));
  }

  /** Read the file (missing → empty). A file of another version, or one
   *  that cannot be read, throws, and the store stays unreadable: it holds
   *  nothing, and writes nothing over the file. */
  load(): void {
    this.records.clear();
    try {
      const raw = readVersionedFile(this.file, PENDING_REMOVALS_VERSION);
      const list = raw && Array.isArray(raw.removals) ? raw.removals : [];
      for (const r of list) if (isRecord(r)) this.records.set(pendingRemovalKey(r.path), r);
      this.loadError = null;
    } catch (err) {
      this.loadError = (err as Error).message;
      throw err;
    }
  }

  unreadable(): string | null {
    return this.loadError;
  }

  get(worktreePath: string): PendingWorktreeRemoval | null {
    const r = this.records.get(pendingRemovalKey(worktreePath));
    return r ? { ...r } : null;
  }

  all(): PendingWorktreeRemoval[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  put(rec: PendingWorktreeRemoval): Promise<void> {
    if (this.loadError !== null) return Promise.reject(new Error(`${this.file} could not be read (${this.loadError}), so nothing is recorded in it`));
    const key = pendingRemovalKey(rec.path);
    this.records.delete(key);
    this.records.set(key, { ...rec });
    for (const k of this.records.keys()) {
      if (this.records.size <= PENDING_REMOVALS_MAX) break;
      if (k !== key) this.records.delete(k);
    }
    return this.write();
  }

  /** A record whose deletion cannot be written stays (the write throws):
   *  the file still holds it, so a restart would find it again, and a later
   *  delete must try the write again rather than find nothing to do. */
  async delete(worktreePath: string): Promise<void> {
    const key = pendingRemovalKey(worktreePath);
    const rec = this.records.get(key);
    if (!rec) return;
    this.records.delete(key);
    try {
      await this.write();
    } catch (err) {
      if (!this.records.has(key)) this.records.set(key, rec);
      throw err;
    }
  }

  private async write(): Promise<void> {
    if (this.loadError !== null) throw new Error(`${this.file} could not be read (${this.loadError}), so it is not written`);
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await this.persister.schedule();
  }
}

/** The store the app's task close uses: a record in it locks its folder
 *  against new panes (pendingRemovalRefusal). */
let active: PendingRemovalStore | null = null;

export function setActivePendingRemovals(store: PendingRemovalStore | null): void {
  active = store;
}

/** The key of a folder as the file system names it: links, junctions and
 *  8.3 short names resolved when it exists. */
function canonicalKey(p: string): string {
  let real = path.resolve(p);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // Not there: compared as spelled.
  }
  return pendingRemovalKey(real);
}

/**
 * Why a pane may not start in `cwd`, or null: a folder whose removal is
 * pending is half deleted, and what a pane wrote there would be checked
 * against it, or deleted with it. A WSL pane's Linux path is read as the
 * Windows folder it is. Both sides are compared canonical, so an alias of
 * the folder (a link, a junction, an 8.3 name) is refused too.
 */
export function pendingRemovalRefusal(cwd: string | null | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!cwd || !active) return null;
  return refusalAmong(cwd, {}, active.all(), platform);
}

function refusalAmong(
  cwd: string,
  session: { wslTarget?: { distribution?: unknown } },
  records: readonly PendingWorktreeRemoval[],
  platform: NodeJS.Platform,
): string | null {
  const want = canonicalKey(sessionHostDir(cwd, session, platform));
  for (const rec of records) {
    // A folder Close and keep folder kept is the owner's: no lock.
    if (rec.keep) continue;
    const held = canonicalKey(rec.path);
    if (want === held || want.startsWith(held + path.sep)) {
      return `${cwd} is inside ${rec.path}, a task folder whose removal did not finish; open the pane in another folder, or use Close and keep folder on its task`;
    }
  }
  return null;
}

/**
 * pendingRemovalRefusal for the daemon, which starts panes the desktop never
 * sees (a phone's, an automation's): read from the store's file under
 * `wmuxDir`. A file that cannot be read refuses nothing here (logged); the
 * desktop's own check and the sweep's last look before a deletion still
 * hold.
 */
export function pendingRemovalRefusalAt(
  wmuxDir: string,
  cwd: string | null | undefined,
  session: { wslTarget?: { distribution?: unknown } } = {},
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!cwd) return null;
  let records: PendingWorktreeRemoval[];
  try {
    const raw = readVersionedFile(path.join(wmuxDir, 'worktask', PENDING_REMOVALS_FILENAME), PENDING_REMOVALS_VERSION);
    records = raw && Array.isArray(raw.removals) ? raw.removals.filter(isRecord) : [];
  } catch (err) {
    console.warn(`[worktask] pending removals not read for a new pane: ${(err as Error).message}`);
    return null;
  }
  return records.length > 0 ? refusalAmong(cwd, session, records, platform) : null;
}

/** What the sweep at start needs (TaskWorktreeManager and the daemon). */
export interface PendingSweepPorts {
  /** The folders whose removal is recorded as pending. */
  paths(): string[];
  /** The daemon's sessions, and whether its start-up recovery is done; null
   *  when the daemon cannot be asked. */
  sessions(): Promise<{ sessions: Array<{ id: string; spawnCwd?: string; cwd?: string; wslTarget?: { distribution?: unknown } }>; recoveryDone: boolean } | null>;
  /** The ids of `sessions` started in `folder` or below it, or working
   *  there now (their current directory). */
  startedIn(folder: string, sessions: Array<{ id: string; spawnCwd?: string; cwd?: string; wslTarget?: { distribution?: unknown } }>): Promise<string[]>;
  /** TaskWorktreeManager.finishPendingRemoval, with nothing to stop. */
  finish(folder: string): Promise<{ ok: boolean; error?: string } | null>;
  log?(message: string): void;
}

/**
 * The sweep at start (#2388): finish each removal a close left part way.
 * Only once the daemon has recovered its sessions, never for a folder a
 * session was started in or works in now (the task's next close stops it
 * first), and only through finishPendingRemoval's checks (the second layer);
 * a folder any check cannot prove keeps its record. One log line per
 * decision. Returns false when it should run again later (the daemon is not
 * ready).
 */
export async function sweepPendingRemovals(ports: PendingSweepPorts): Promise<boolean> {
  const log = (m: string): void => ports.log?.(`[worktask] pending removal sweep: ${m}`);
  const paths = ports.paths();
  if (paths.length === 0) return true;
  const listed = await ports.sessions().catch(() => null);
  if (!listed || !listed.recoveryDone) {
    log(`${paths.length} folder(s) wait: ${listed ? 'the daemon is still recovering its sessions' : 'the daemon cannot be asked'}`);
    return false;
  }
  for (const folder of paths) {
    const inUse = await ports.startedIn(folder, listed.sessions);
    if (inUse.length > 0) {
      log(`kept ${folder}: ${inUse.length} session(s) were started or work in it`);
      continue;
    }
    const r = await ports.finish(folder).catch((err: unknown) => ({ ok: false, error: String(err) }));
    if (r === null) log(`${folder}: no pending removal is recorded any more`);
    else if (r.ok) log(`removed ${folder}`);
    else log(`kept ${folder}: ${r.error ?? 'unknown'}`);
  }
  return true;
}
