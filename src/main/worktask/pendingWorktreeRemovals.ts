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
import { createSerialChain } from '../deck/serialChain';
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
  at: number;
}

function isRecord(v: unknown): v is PendingWorktreeRemoval {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.path === 'string' && path.isAbsolute(r.path) && typeof r.repoRoot === 'string' && typeof r.repoHash === 'string'
    && (r.head === undefined || (typeof r.head === 'string' && /^[0-9a-f]{40,64}$/.test(r.head)))
    && typeof r.at === 'number';
}

/** The key of a folder: resolved, compared without case on Windows and macOS. */
export function pendingRemovalKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export interface PendingRemovalStore {
  get(worktreePath: string): PendingWorktreeRemoval | null;
  all(): PendingWorktreeRemoval[];
  put(rec: PendingWorktreeRemoval): Promise<void>;
  delete(worktreePath: string): Promise<void>;
}

export class PendingWorktreeRemovals implements PendingRemovalStore {
  private readonly records = new Map<string, PendingWorktreeRemoval>();
  private readonly persister: FilePersister;

  /** Every change runs whole (change, write, roll back) one at a time: a
   *  write that started while an earlier change was still to be rolled back
   *  would put that change on disk while memory drops it. */
  private readonly serial = createSerialChain();

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: PENDING_REMOVALS_VERSION, removals: [...this.records.values()] }));
  }

  static at(wmuxDir: string): PendingWorktreeRemovals {
    return new PendingWorktreeRemovals(path.join(wmuxDir, 'worktask', PENDING_REMOVALS_FILENAME));
  }

  /** Read the file (missing → empty). A file of another version throws. */
  load(): void {
    this.records.clear();
    const raw = readVersionedFile(this.file, PENDING_REMOVALS_VERSION);
    const list = raw && Array.isArray(raw.removals) ? raw.removals : [];
    for (const r of list) if (isRecord(r)) this.records.set(pendingRemovalKey(r.path), r);
  }

  get(worktreePath: string): PendingWorktreeRemoval | null {
    const r = this.records.get(pendingRemovalKey(worktreePath));
    return r ? { ...r } : null;
  }

  all(): PendingWorktreeRemoval[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** A record whose write fails is not taken (the write throws): memory
   *  goes back to what the file holds, so a retry writes again rather than
   *  find the change made. */
  put(rec: PendingWorktreeRemoval): Promise<void> {
    return this.serial(() => this.putNow(rec));
  }

  private async putNow(rec: PendingWorktreeRemoval): Promise<void> {
    const key = pendingRemovalKey(rec.path);
    const prev = this.records.get(key);
    const next = { ...rec };
    this.records.delete(key);
    this.records.set(key, next);
    const dropped: Array<[string, PendingWorktreeRemoval]> = [];
    for (const [k, v] of this.records) {
      if (this.records.size <= PENDING_REMOVALS_MAX) break;
      if (k === key) continue;
      this.records.delete(k);
      dropped.push([k, v]);
    }
    try {
      await this.write();
    } catch (err) {
      if (this.records.get(key) === next) {
        if (prev) this.records.set(key, prev);
        else this.records.delete(key);
      }
      for (const [k, v] of dropped) if (!this.records.has(k)) this.records.set(k, v);
      throw err;
    }
  }

  /** A record whose deletion cannot be written stays (the write throws):
   *  the file still holds it, so a restart would find it again, and a later
   *  delete must try the write again rather than find nothing to do. */
  delete(worktreePath: string): Promise<void> {
    return this.serial(() => this.deleteNow(worktreePath));
  }

  private async deleteNow(worktreePath: string): Promise<void> {
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
    const held = canonicalKey(rec.path);
    if (want === held || want.startsWith(held + path.sep)) {
      return `${cwd} is inside ${rec.path}, a task folder whose removal did not finish; open the pane in another folder, or close its task again to finish the removal`;
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
