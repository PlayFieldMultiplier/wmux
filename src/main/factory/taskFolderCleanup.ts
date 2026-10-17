// ─── An ended bot task's folder is removed once nothing is left in it ──────
//
// Owner decision 2026-10-16: when a bot task ENDS (`completed`, `cancelled`
// or `failed` in the ledger), its folder goes right away, provided nothing in
// it is uncommitted. The branch stays.
//   - A task worktree (under `<wmux home>/worktrees/`, a `wtask/` branch) is
//     removed with `git worktree remove`, never forced
//     (TaskWorktreeManager.removeWorktree: `git status --porcelain` must be
//     empty; ignored files such as node_modules do not count and go with the
//     folder). A dirty worktree is kept and never removed automatically; the
//     task shows a note and Settings › Bots counts it. A detached HEAD (a
//     verify task's checkout) with commits no ref holds first gets
//     `refs/wmux/keep/<taskId>`, so removal never leaves them to gc.
//   - A research task's scratch folder
//     (`<wmux data>/factory/bots/<botId>/research/<batch>/<task>`) is removed;
//     its report is in the ledger and the room.
//   - Only once the task's processes are stopped: its worker is not resumed
//     or still stopping (workerReclaim.ts), and no daemon session was started
//     in the folder or has its working directory there. A failed task's
//     workspace stays open until the owner looked at it, so its folder waits
//     for that too.
//   - Only bot tasks' own folders: a ledger row a bot started, whose folder
//     sits under one of the two roots above. Owner fan-outs, phone worktrees
//     and worktrees made by hand are never touched.
//   - Not a task the owner stopped (cancelled "stopped by owner": Stop
//     worker, a bot's Stop, Stop all, "Run bots" off). A stop deletes
//     nothing (factoryStop.ts), so the owner can look at what the worker
//     left; only the owner's Clean up now applies the rules to it. Such a
//     folder is recorded (`kept_stopped`, with its bot), so Clean up now
//     and the usage line still find it once the ledger has pruned the
//     task's row; a removal ends that. A resume of its worker keeps the
//     record (the row may be pruned before the worker stops again).
//     Owner decision 2026-10-17: a kept folder that has sat for
//     TASK_FOLDER_KEPT_TTL_MS (7 days) since it was recorded is removed by
//     the automatic pass when it is still clean, with every check above
//     (inside its root through no link, no process or session in it, its
//     worker not resumed, the branch kept, the keep ref for a detached
//     HEAD). A dirty one goes to `kept_dirty` and is never removed
//     automatically. The 7 days count from the task's last stop: a resume
//     restarts them, and when the resumed worker stops again (the owner's
//     stop, an idle pause, its agent's exit) the record is refreshed to that
//     stop, or written then if it is missing. A removal posts one quiet card in the task's thread
//     (`task.keptFolderCleaned`): the record keeps the task's title and
//     thread, since the ledger prunes the row after about as long.
// What was removed is recorded in `<wmuxDir>/factory/task-folders.json`, with
// the repository and branch to put it back. A resume of the task's worker
// (workerReclaim.ts respawn, the owner's Resume or `worker_resume`) puts the
// folder back at the SAME path first (the branch checked out again, or an
// empty research folder), so the agent's per-folder conversation resumes.
// A folder put back is removed again when its task's worker stops again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LedgerEntry } from '../../shared/ledger';
import { BOT_ID_RE } from '../../shared/bot';
import { getExecEnv } from '../../shared/execEnv';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { sessionHostDir } from '../worktask/stopSessionsInDir';
import { STOPPED_BY_OWNER, STOP_SYSTEM_WORKSPACE, isStoppedByOwnerRow } from './factoryStop';

export const TASK_FOLDERS_FILENAME = 'task-folders.json';
export const TASK_FOLDERS_VERSION = 1 as const;
/** Records kept (oldest dropped first). */
export const TASK_FOLDERS_MAX = 2000;
/** Records of folders a stop kept, on a budget of their own (a folder
 *  dropped past it is never deleted, only no longer listed). */
export const TASK_FOLDERS_KEPT_MAX = 2000;
/** How far back an ended task is looked at by the automatic pass. */
export const TASK_FOLDER_CATCHUP_MS = 24 * 3_600_000;
/** Attempts per task and end before the automatic pass gives up on a
 *  removal git refused (Clean up now tries again). */
export const TASK_FOLDER_ATTEMPTS_MAX = 3;

/** A folder put back for a resume is left alone this long by the automatic
 *  pass: the resumed worker's pane opens in it within that time. */
export const TASK_FOLDER_RESTORE_HOLD_MS = 5 * 60_000;

/** A folder a stop kept, still clean this long after it was recorded, is
 *  removed by the automatic pass (owner decision 2026-10-17). */
export const TASK_FOLDER_KEPT_TTL_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type TaskFolderKind = 'worktree' | 'research';

/** One bot task's folder, as this module last left it. */
export interface TaskFolderRecord {
  taskId: string;
  kind: TaskFolderKind;
  path: string;
  /** being removed (written before the folder goes, so a crash keeps how to
   *  put it back) · removed · kept (uncommitted changes) · put back for a
   *  resume · kept because the owner stopped the task. */
  state: 'removing' | 'removed' | 'kept_dirty' | 'restored' | 'kept_stopped';
  /** A folder a stop kept: its task's bot, so Clean up now can look at it
   *  without the task's ledger row (pruned after a while), and the task's
   *  title, owner workspace and thread, for the card of a removal after
   *  TASK_FOLDER_KEPT_TTL_MS. */
  stopped?: { botId: string; title?: string; workspaceId?: string; threadId?: string };
  /** A worktree's repository, and its branch or (a detached checkout, such
   *  as a verify task's) its commit, recorded before removal. */
  repoRoot?: string;
  repoHash?: string;
  branch?: string;
  head?: string;
  /** The ref that holds a detached HEAD's commits no other ref held
   *  (`refs/wmux/keep/<taskId>`), written before the worktree went. */
  keepRef?: string;
  at: number;
}

function isRecord(v: unknown): v is TaskFolderRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && (r.kind === 'worktree' || r.kind === 'research') && typeof r.path === 'string'
    && (r.state === 'removing' || r.state === 'removed' || r.state === 'kept_dirty' || r.state === 'restored' || r.state === 'kept_stopped')
    && typeof r.at === 'number'
    && (r.stopped === undefined || (typeof r.stopped === 'object' && r.stopped !== null && typeof (r.stopped as { botId?: unknown }).botId === 'string'
      && BOT_ID_RE.test((r.stopped as { botId: string }).botId)));
}

/** A record of a folder a stop kept that is not gone yet (kept, kept dirty
 *  after a Clean up now, or a removal that has not finished): what Clean up
 *  now and the usage line find without the task's row. Never evicted. */
function isKeptRecord(r: TaskFolderRecord): boolean {
  return !!r.stopped && (r.state === 'kept_stopped' || r.state === 'kept_dirty' || r.state === 'removing');
}

export class TaskFolders {
  private readonly records = new Map<string, TaskFolderRecord>();
  private readonly persister: FilePersister;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: TASK_FOLDERS_VERSION, folders: [...this.records.values()] }));
  }

  static at(wmuxDir: string): TaskFolders {
    return new TaskFolders(path.join(wmuxDir, 'factory', TASK_FOLDERS_FILENAME));
  }

  /** Read the file (missing → empty). A file of another version throws. */
  load(): void {
    this.records.clear();
    const raw = readVersionedFile(this.file, TASK_FOLDERS_VERSION);
    const list = raw && Array.isArray(raw.folders) ? raw.folders : [];
    for (const r of list) if (isRecord(r)) this.records.set(r.taskId, r);
  }

  get(taskId: string): TaskFolderRecord | null {
    const r = this.records.get(taskId);
    return r ? { ...r } : null;
  }

  all(): TaskFolderRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  put(rec: TaskFolderRecord): Promise<void> {
    this.records.delete(rec.taskId);
    this.records.set(rec.taskId, rec);
    // Two budgets, each dropped oldest first: the folders a stop kept (their
    // record is the only way Clean up now finds one once the ledger pruned
    // its row) and every other record, so neither crowds the other out. The
    // record being written is never the one dropped.
    let kept = 0;
    for (const r of this.records.values()) if (isKeptRecord(r)) kept++;
    let other = this.records.size - kept;
    for (const [id, r] of this.records) {
      if (kept <= TASK_FOLDERS_KEPT_MAX && other <= TASK_FOLDERS_MAX) break;
      if (id === rec.taskId) continue;
      if (isKeptRecord(r)) {
        if (kept <= TASK_FOLDERS_KEPT_MAX) continue;
        kept--;
      } else {
        if (other <= TASK_FOLDERS_MAX) continue;
        other--;
      }
      this.records.delete(id);
    }
    return this.persister.schedule();
  }

  /** Forget a task's record (a kept folder its resumed worker uses again). */
  delete(taskId: string): Promise<void> {
    if (!this.records.delete(taskId)) return Promise.resolve();
    return this.persister.schedule();
  }
}

/** Whether `child` is `parent` or inside it. Pure. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Where bot task folders may live. */
export interface TaskFolderRoots {
  /** `<wmux home>/worktrees` (TaskWorktreeManager). */
  worktrees: string;
  /** The wmux data folder (bots' research roots under `factory/bots/`). */
  wmuxDir: string;
}

/** Which kind of bot task folder this is, or null when it is none this
 *  module may touch: a worktree strictly inside the task worktree root on a
 *  `wtask/` branch (or detached: no branch), or a task folder strictly inside
 *  the bot's own research root (a batch and a task below it). Pure. */
export function taskFolderKind(folder: string, branch: string | undefined, botId: string, roots: TaskFolderRoots): TaskFolderKind | null {
  if (!folder || !path.isAbsolute(folder)) return null;
  // A bot id names one folder under the bots' root (no separators, no "..").
  if (!BOT_ID_RE.test(botId)) return null;
  const research = path.join(roots.wmuxDir, 'factory', 'bots', botId, 'research');
  const relResearch = path.relative(research, path.resolve(folder));
  if (relResearch && !relResearch.startsWith('..') && !path.isAbsolute(relResearch) && relResearch.split(path.sep).length >= 2) return 'research';
  const relWorktree = path.relative(path.resolve(roots.worktrees), path.resolve(folder));
  if (relWorktree && !relWorktree.startsWith('..') && !path.isAbsolute(relWorktree) && relWorktree.split(path.sep).length >= 2) {
    return branch === undefined || branch.startsWith('wtask/') ? 'worktree' : null;
  }
  return null;
}

/** The folder a mission names for a task, and its branch. */
export interface TaskMission {
  folder: string;
  branch?: string;
  /** The task was detached: its worktree was handed to the owner. */
  detached?: boolean;
}

export interface TaskFolderSession {
  id: string;
  spawnCwd?: string;
  cwd?: string;
  wslTarget?: { distribution?: unknown };
}

export interface TaskFolderPorts {
  store: TaskFolders;
  roots: TaskFolderRoots;
  /** The missions of an owner workspace by task id (`task.mission.list`);
   *  null when the daemon cannot be read. */
  missions: (ownerWorkspaceId: string) => Promise<Map<string, TaskMission> | null>;
  /** Every daemon session; throws when the daemon cannot be read. */
  listSessions: () => Promise<TaskFolderSession[]>;
  /** The task's reclaimed worker: `resumed` and `stopping` still run. */
  workerState: (taskId: string) => 'stopping' | 'stopped' | 'resumed' | null;
  /** When the task's reclaimed worker was last stopped, while it is
   *  stopped (a resumed worker stopped again). Absent: not known. */
  workerStoppedAt?: (taskId: string) => number | undefined;
  worktrees: {
    removeWorktree(repoRoot: string, repoHash: string, worktreePath: string): Promise<{ ok: true } | { ok: false; error: string; dirty?: boolean }>;
    restoreWorktree(repoRoot: string, repoHash: string, worktreePath: string, ref: string, detached?: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  /** A worktree's main repository root, its hash (the manager's lock key)
   *  and its checked-out commit. */
  repoInfo: (worktreePath: string) => Promise<{ repoRoot: string; repoHash: string; head?: string } | null>;
  /** Whether a task gate's process runs for this task now (its own spawn,
   *  not a daemon session). Absent: none. */
  gateRunning?: (taskId: string) => boolean;
  /** Default: fs. */
  removeDir?: (dir: string) => Promise<void>;
  makeDir?: (dir: string) => Promise<void>;
  exists?: (p: string) => boolean;
  now?: () => number;
  log?: (msg: string) => void;
  /** The Bots page re-reads (a task's note). */
  changed?: () => void;
  /** A folder a stop kept was removed after TASK_FOLDER_KEPT_TTL_MS: one
   *  card in the task's thread. Absent: no card. */
  keptFolderCleaned?: (info: KeptFolderCleaned) => void;
}

/** What the card of a kept folder removed after its TTL says. */
export interface KeptFolderCleaned {
  taskId: string;
  botId: string;
  kind: TaskFolderKind;
  title: string;
  days: number;
  workspaceId?: string;
  threadId?: string;
}

export type TaskFolderOutcome = 'removed' | 'kept_dirty' | 'busy' | 'skipped' | 'failed';

/** Whether a row is an ended task a bot started. Pure. */
export function isEndedBotTask(row: Pick<LedgerEntry, 'status' | 'dispatch'>): boolean {
  const origin = row.dispatch?.origin;
  return origin?.kind === 'bot' && !!origin.botId && (row.status === 'completed' || row.status === 'cancelled' || row.status === 'failed');
}

function defaultExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Whether any daemon session was started in the folder or works in it now
 *  (a WSL pane's Linux path read as the Windows folder it is). */
function folderInUse(folder: string, sessions: readonly TaskFolderSession[]): boolean {
  let real = folder;
  try {
    real = fs.realpathSync(folder);
  } catch {
    /* compared as given */
  }
  return sessions.some((s) => [s.spawnCwd, s.cwd].some((d) => {
    if (typeof d !== 'string' || d.length === 0) return false;
    const host = sessionHostDir(d, s);
    return isInside(host, folder) || isInside(host, real);
  }));
}

/** taskId → the cleanup running on its folder (one at a time per task). */
const folderOps = new Map<string, Promise<unknown>>();
/** taskId → resumes holding its folder: no cleanup removes it meanwhile. */
const folderHolds = new Map<string, number>();

/**
 * A resume holds the task's folder while it relaunches the worker: a cleanup
 * that starts meanwhile leaves the folder alone, and one already running is
 * waited for (its folder is then put back by the resume). Returns the
 * release; once the worker runs, its pane and its `resumed` state keep the
 * folder.
 */
export async function holdTaskFolder(taskId: string): Promise<() => void> {
  folderHolds.set(taskId, (folderHolds.get(taskId) ?? 0) + 1);
  await (folderOps.get(taskId) ?? Promise.resolve()).catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (folderHolds.get(taskId) ?? 1) - 1;
    if (n <= 0) folderHolds.delete(taskId);
    else folderHolds.set(taskId, n);
  };
}

/** Whether the folder is where its root says, through no link: the real
 *  path relative to the root's real path is the path as written. */
function throughNoLink(folder: string, root: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const realFolder = fs.realpathSync(folder);
    const rel = path.relative(realRoot, realFolder);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel === path.relative(path.resolve(root), path.resolve(folder));
  } catch {
    return false;
  }
}

/**
 * Remove one ended bot task's folder when the rules allow it. `force`: the
 * owner's Clean up now (a folder kept dirty, or one a stop kept, is looked
 * at again). Never throws. `skipped`: not a bot task's folder, not ended,
 * stopped by the owner (without `force`), detached, already
 * handled, held by a resume, or a worker still runs; `busy`: a session or a
 * gate still uses the folder.
 */
export function cleanTaskFolder(
  ports: TaskFolderPorts,
  entry: LedgerEntry,
  mission: TaskMission | null,
  sessions: readonly TaskFolderSession[],
  opts: { force?: boolean; keptTtl?: boolean } = {},
): Promise<TaskFolderOutcome> {
  const prev = folderOps.get(entry.id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => cleanTaskFolderNow(ports, entry, mission, sessions, opts));
  folderOps.set(entry.id, run);
  void run.finally(() => {
    if (folderOps.get(entry.id) === run) folderOps.delete(entry.id);
  }).catch(() => undefined);
  return run;
}

async function cleanTaskFolderNow(
  ports: TaskFolderPorts,
  entry: LedgerEntry,
  mission: TaskMission | null,
  sessions: readonly TaskFolderSession[],
  opts: { force?: boolean; keptTtl?: boolean },
): Promise<TaskFolderOutcome> {
  const now = ports.now ?? Date.now;
  const log = ports.log ?? ((m: string) => console.warn(m));
  const exists = ports.exists ?? defaultExists;
  if (!isEndedBotTask(entry) || !mission || mission.detached === true) return 'skipped';
  const botId = entry.dispatch?.origin.botId ?? '';
  const kind = taskFolderKind(mission.folder, mission.branch, botId, ports.roots);
  if (!kind) return 'skipped';
  const prior = ports.store.get(entry.id);
  const stoppedByOwner = isStoppedByOwnerRow(entry);
  // A folder a stop kept, past its TTL: the automatic pass applies the
  // rules to it (a dirty one is kept, as always).
  const stopAt = ports.workerStoppedAt?.(entry.id);
  const expired = opts.keptTtl === true && prior?.state === 'kept_stopped' && !!prior.stopped
    && now() - Math.max(prior.at, stopAt ?? -Infinity) >= TASK_FOLDER_KEPT_TTL_MS;
  // A task the owner stopped keeps its folder; Clean up now still applies.
  // It is recorded, so it is found once the ledger has pruned the row.
  if (stoppedByOwner && opts.force !== true && !expired) {
    // A removal that did not finish (its folder still there) is kept again.
    // Not while its worker runs again (resumed, or still stopping): the
    // record, and its 7 days, start at the next stop.
    const worker = ports.workerState(entry.id);
    // A resumed worker stopped again since: its 7 days start at that stop.
    const restopped = worker === 'stopped' && stopAt !== undefined && stopAt > entry.updatedAt ? stopAt : undefined;
    if (prior?.state === 'kept_stopped' && restopped !== undefined && restopped > prior.at) {
      await ports.store.put({ ...prior, at: restopped }).catch((err: unknown) => log(`[factory] kept folder of ${entry.id} not refreshed: ${String(err)}`));
    }
    if (prior?.state !== 'kept_stopped' && prior?.state !== 'removed' && worker !== 'resumed' && worker !== 'stopping' && exists(mission.folder)) {
      const thread = entry.dispatch?.threadId;
      await ports.store.put({
        taskId: entry.id, kind, path: mission.folder, state: 'kept_stopped',
        stopped: {
          botId,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.ownerWorkspaceId ? { workspaceId: entry.ownerWorkspaceId } : {}),
          ...(entry.ownerWorkspaceId ? { threadId: typeof thread === 'string' && thread ? thread : `task:${entry.id}` } : {}),
        },
        ...(mission.branch ? { branch: mission.branch } : prior?.branch ? { branch: prior.branch } : {}),
        ...(prior?.repoRoot ? { repoRoot: prior.repoRoot } : {}),
        ...(prior?.repoHash ? { repoHash: prior.repoHash } : {}),
        ...(prior?.head ? { head: prior.head } : {}),
        ...(prior?.keepRef ? { keepRef: prior.keepRef } : {}),
        // A folder already recorded (a removal that did not finish) keeps
        // its clock.
        at: restopped ?? (prior?.stopped ? prior.at : now()),
      }).catch((err: unknown) => log(`[factory] kept folder of ${entry.id} not recorded: ${String(err)}`));
    }
    return 'skipped';
  }
  // Every later record of a folder a stop kept says so (Clean up now finds it).
  const stoppedMark = prior?.stopped ? { stopped: prior.stopped } : stoppedByOwner ? { stopped: { botId } } : {};
  // A folder a stop kept keeps its clock through a removal that does not
  // finish; any other record says when it was written.
  const keptAt = prior?.stopped && (prior.state === 'kept_stopped' || prior.state === 'removing' || prior.state === 'kept_dirty')
    ? Math.max(prior.at, stopAt ?? -Infinity) : undefined;
  // A removal after the TTL that failed is kept again as it was, so the next
  // pass tries it again (TASK_FOLDER_ATTEMPTS_MAX).
  const keepAgain = async (): Promise<void> => {
    if (expired && prior) await ports.store.put({ ...prior, state: 'kept_stopped', at: keptAt ?? prior.at }).catch(() => undefined);
  };
  if ((folderHolds.get(entry.id) ?? 0) > 0) return 'skipped';
  if (prior?.state === 'removed') return 'skipped';
  if (prior?.state === 'kept_dirty' && opts.force !== true) return 'skipped';
  if (prior?.state === 'restored' && now() - prior.at < TASK_FOLDER_RESTORE_HOLD_MS) return 'skipped';
  const worker = ports.workerState(entry.id);
  if (worker === 'resumed' || worker === 'stopping') return 'skipped';
  const keep = {
    ...(prior?.repoRoot ? { repoRoot: prior.repoRoot } : {}),
    ...(prior?.repoHash ? { repoHash: prior.repoHash } : {}),
    ...(prior?.head ? { head: prior.head } : {}),
    ...(mission.branch ? { branch: mission.branch } : prior?.branch ? { branch: prior.branch } : {}),
  };
  if (!exists(mission.folder)) {
    // Gone already (by hand, or a removal that finished before a crash).
    await ports.store.put({ taskId: entry.id, kind, path: mission.folder, state: 'removed', ...keep, ...stoppedMark, at: now() }).catch(() => undefined);
    return 'skipped';
  }
  if (folderInUse(mission.folder, sessions)) return 'busy';
  if (ports.gateRunning?.(entry.id) === true) return 'busy';
  const root = kind === 'research' ? path.join(ports.roots.wmuxDir, 'factory', 'bots', botId, 'research') : ports.roots.worktrees;
  if (!throughNoLink(mission.folder, root)) {
    log(`[factory] folder of ${entry.id} left alone: it is not where its root says (a link)`);
    return 'skipped';
  }
  if (kind === 'research') {
    try {
      if (!fs.lstatSync(mission.folder).isDirectory()) return 'skipped';
      await ports.store.put({ taskId: entry.id, kind, path: mission.folder, state: 'removing', ...stoppedMark, at: keptAt ?? now() });
      await (ports.removeDir ?? ((d: string) => fs.promises.rm(d, { recursive: true })))(mission.folder);
    } catch (err) {
      log(`[factory] research folder of ${entry.id} not removed: ${String(err)}`);
      if (fs.existsSync(mission.folder)) await keepAgain();
      return 'failed';
    }
    await ports.store.put({ taskId: entry.id, kind, path: mission.folder, state: 'removed', at: now() }).catch(() => undefined);
    removeEmptyResearchBatch(ports.store, path.dirname(mission.folder), root, log);
    if (expired && prior) noteKeptFolderCleaned(ports, entry, prior, now(), log);
    ports.changed?.();
    return 'removed';
  }
  const repo = await ports.repoInfo(mission.folder).catch(() => null);
  // A detached checkout comes back on its commit, so it needs one.
  if (!repo || (!mission.branch && !repo.head)) {
    log(`[factory] worktree of ${entry.id} not removed: its repository could not be read`);
    return 'failed';
  }
  if ((folderHolds.get(entry.id) ?? 0) > 0) return 'skipped';
  // Commits made on a detached HEAD are held by no branch: a ref keeps them
  // before the worktree (and with it HEAD's reflog) goes.
  const kept = await keepDetachedCommits(repo.repoRoot, mission.folder, entry.id, mission.branch, repo.head, entry.dispatch?.checkout?.sha);
  if (kept === null) {
    log(`[factory] worktree of ${entry.id} not removed: whether its commits are kept could not be read`);
    return 'failed';
  }
  const base = {
    taskId: entry.id, kind, path: mission.folder, repoRoot: repo.repoRoot, repoHash: repo.repoHash,
    ...(mission.branch ? { branch: mission.branch } : {}), ...(repo.head ? { head: repo.head } : {}),
    ...(kept ? { keepRef: kept } : prior?.keepRef ? { keepRef: prior.keepRef } : {}), ...stoppedMark, at: keptAt ?? now(),
  };
  // How to put it back is on disk before the folder goes.
  try {
    await ports.store.put({ ...base, state: 'removing' });
  } catch (err) {
    log(`[factory] worktree of ${entry.id} not removed: its record could not be written: ${String(err)}`);
    return 'failed';
  }
  const r = await ports.worktrees.removeWorktree(repo.repoRoot, repo.repoHash, mission.folder).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
  if (r.ok) {
    await ports.store.put({ ...base, state: 'removed', at: now() }).catch(() => undefined);
    if (expired && prior) noteKeptFolderCleaned(ports, entry, prior, now(), log);
    ports.changed?.();
    return 'removed';
  }
  if ('dirty' in r && r.dirty === true) {
    await ports.store.put({ ...base, state: 'kept_dirty' }).catch(() => undefined);
    if (prior?.state !== 'kept_dirty') ports.changed?.();
    return 'kept_dirty';
  }
  log(`[factory] worktree of ${entry.id} not removed: ${r.error}`);
  if (exists(mission.folder)) await keepAgain();
  return 'failed';
}

/** The card of a kept folder removed after its TTL. Never throws. */
function noteKeptFolderCleaned(ports: TaskFolderPorts, entry: LedgerEntry, prior: TaskFolderRecord, at: number, log: (m: string) => void): void {
  const s = prior.stopped;
  if (!s || !ports.keptFolderCleaned) return;
  try {
    ports.keptFolderCleaned({
      taskId: entry.id, botId: s.botId, kind: prior.kind,
      title: (typeof s.title === 'string' && s.title) || entry.title || entry.id,
      days: Math.floor((at - prior.at) / DAY_MS),
      ...(typeof s.workspaceId === 'string' && s.workspaceId ? { workspaceId: s.workspaceId } : {}),
      ...(typeof s.threadId === 'string' && s.threadId ? { threadId: s.threadId } : {}),
    });
  } catch (err) {
    log(`[factory] card for the kept folder of ${entry.id} not posted: ${String(err)}`);
  }
}

/**
 * A research batch (`research/<batch>/`) whose task folders are all gone:
 * removed with its `.meta` once nothing else is in it and every `.meta/<task>`
 * belongs to a task this module removed (so none of the batch's tasks is
 * still open). A task of the batch that starts later re-creates the batch
 * (FanOutService). Only a batch right under the bot's research root, reached
 * through no link. Synchronous on purpose: main's fan-out creates task
 * folders synchronously too, so no task folder can appear between the check
 * and the removal. Never throws.
 */
export function removeEmptyResearchBatch(store: Pick<TaskFolders, 'all'>, batch: string, root: string, log: (m: string) => void = () => undefined): boolean {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(batch));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return false;
    if (!throughNoLink(batch, root)) return false;
    const entries = fs.readdirSync(batch);
    if (entries.some((e) => e !== '.meta')) return false;
    if (entries.length > 0) {
      const meta = path.join(batch, '.meta');
      if (!fs.lstatSync(meta).isDirectory()) return false;
      const removed = new Set(store.all().filter((r) => r.kind === 'research' && r.state === 'removed').map((r) => path.resolve(r.path)));
      if (fs.readdirSync(meta).some((leaf) => !removed.has(path.resolve(batch, leaf)))) return false;
    }
    fs.rmSync(batch, { recursive: true });
    return true;
  } catch (err) {
    log(`[factory] research batch ${batch} not removed: ${String(err)}`);
    return false;
  }
}

/** What a pass over many tasks did. */
export interface TaskFolderSweep {
  removed: number;
  keptDirty: number;
  busy: number;
  failed: number;
}

/** Apply the rules to these rows (ended bot tasks; anything else is
 *  skipped). One mission read per owner workspace and one session read.
 *  Throws when the daemon's sessions cannot be read (nothing is removed). */
export async function cleanTaskFolders(ports: TaskFolderPorts, rows: readonly LedgerEntry[], opts: { force?: boolean } = {}): Promise<TaskFolderSweep> {
  const out: TaskFolderSweep = { removed: 0, keptDirty: 0, busy: 0, failed: 0 };
  const ended = rows.filter(isEndedBotTask);
  if (ended.length === 0 && keptRecords(ports.store).length === 0) return out;
  const sessions = await ports.listSessions();
  const byOwner = new Map<string, Map<string, TaskMission> | null>();
  const count = (r: TaskFolderOutcome): void => {
    if (r === 'removed') out.removed++;
    else if (r === 'kept_dirty') out.keptDirty++;
    else if (r === 'busy') out.busy++;
    else if (r === 'failed') out.failed++;
  };
  const handled = new Set<string>();
  for (const row of ended) {
    if (!byOwner.has(row.ownerWorkspaceId)) byOwner.set(row.ownerWorkspaceId, await ports.missions(row.ownerWorkspaceId).catch(() => null));
    const mission = byOwner.get(row.ownerWorkspaceId)?.get(row.id) ?? null;
    if (mission) handled.add(row.id);
    count(await cleanTaskFolder(ports, row, mission, sessions, opts));
  }
  // A folder a stop kept whose row (or mission) is gone — the ledger prunes
  // ended rows after a while: its record says where it is.
  for (const rec of keptRecords(ports.store)) {
    if (handled.has(rec.taskId)) continue;
    count(await cleanTaskFolder(ports, keptRow(rec), { folder: rec.path, ...(rec.branch ? { branch: rec.branch } : {}) }, sessions, opts));
  }
  return out;
}

/** The folders a stop kept (kept dirty too, once Clean up now looked at one),
 *  as recorded: found without the task's ledger row. */
function keptRecords(store: Pick<TaskFolders, 'all'>): TaskFolderRecord[] {
  return store.all().filter(isKeptRecord);
}

/** The task row a kept folder's record stands for once the ledger pruned it:
 *  an ended bot task the owner stopped, so the usual rules (and the checks
 *  on its folder and its bot's roots) apply to it. */
function keptRow(rec: TaskFolderRecord): LedgerEntry {
  return {
    schemaVersion: 1, id: rec.taskId, taskWorkspaceId: '', ownerWorkspaceId: '', title: '',
    status: 'cancelled', rev: 0, updatedAt: rec.at, summary: STOPPED_BY_OWNER,
    updatedBy: { kind: 'system', workspaceId: STOP_SYSTEM_WORKSPACE },
    dispatch: { origin: { kind: 'bot', botId: rec.stopped?.botId ?? '' }, preset: rec.kind === 'research' ? 'research' : 'default' },
  } as LedgerEntry;
}

/** A resumed worker uses its task's folder again: a folder a stop kept stays
 *  recorded (its row may be pruned before the worker stops again), and its
 *  7 days start again (TASK_FOLDER_KEPT_TTL_MS; the worker's next stop moves
 *  them to that stop). */
export async function forgetKeptFolder(ports: Pick<TaskFolderPorts, 'store' | 'now'>, taskId: string): Promise<void> {
  const rec = ports.store.get(taskId);
  if (rec?.state !== 'kept_stopped') return;
  await ports.store.put({ ...rec, at: (ports.now ?? Date.now)() }).catch(() => undefined);
}

/** The task's resumed worker stopped again at `at`: a folder a stop kept
 *  counts its 7 days from then. Written at the stop itself, so the clock
 *  does not depend on the reclaimed worker's record outliving its cap. */
export async function noteKeptFolderStopped(ports: Pick<TaskFolderPorts, 'store'>, taskId: string, at: number): Promise<void> {
  const rec = ports.store.get(taskId);
  if (rec?.state !== 'kept_stopped' || at <= rec.at) return;
  await ports.store.put({ ...rec, at }).catch(() => undefined);
}

/**
 * Put a removed task folder back at the same path for a resume: the worktree
 * on its kept branch, or an empty research folder. Only the folder this
 * module removed for that task, and only at that path. True when the folder
 * is there now.
 */
export async function restoreTaskFolder(ports: TaskFolderPorts, taskId: string, folder: string): Promise<boolean> {
  const rec = ports.store.get(taskId);
  if (!rec || (rec.state !== 'removed' && rec.state !== 'removing') || path.resolve(rec.path) !== path.resolve(folder)) return false;
  const exists = ports.exists ?? defaultExists;
  if (exists(rec.path)) return false;
  const now = ports.now ?? Date.now;
  if (rec.kind === 'research') {
    try {
      await (ports.makeDir ?? ((d: string) => fs.promises.mkdir(d, { recursive: true }).then(() => undefined)))(rec.path);
    } catch {
      return false;
    }
  } else {
    const ref = rec.branch ?? rec.head;
    if (!rec.repoRoot || !rec.repoHash || !ref) return false;
    const r = await ports.worktrees.restoreWorktree(rec.repoRoot, rec.repoHash, rec.path, ref, !rec.branch).catch(() => ({ ok: false as const, error: 'threw' }));
    if (!r.ok) {
      (ports.log ?? ((m: string) => console.warn(m)))(`[factory] worktree of ${taskId} not put back: ${r.error}`);
      return false;
    }
  }
  await ports.store.put({ ...rec, state: 'restored', at: now() }).catch(() => undefined);
  ports.changed?.();
  return true;
}

/** Bytes under a folder: files counted once, links never followed. */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fs.promises.lstat(p)).size;
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  return total;
}

/** The space bot task folders use now. */
export interface TaskFolderUsage {
  bytes: number;
  /** Folders on disk. */
  folders: number;
  /** Of those, ended tasks' folders kept for uncommitted changes. */
  dirty: number;
}

/** Sum the bot task folders the ledger names that are on disk (any status). */
export async function taskFolderUsage(ports: TaskFolderPorts, rows: readonly LedgerEntry[]): Promise<TaskFolderUsage> {
  const exists = ports.exists ?? defaultExists;
  const out: TaskFolderUsage = { bytes: 0, folders: 0, dirty: 0 };
  const byOwner = new Map<string, Map<string, TaskMission> | null>();
  const seen = new Set<string>();
  for (const row of rows) {
    const origin = row.dispatch?.origin;
    if (origin?.kind !== 'bot' || !origin.botId) continue;
    if (!byOwner.has(row.ownerWorkspaceId)) byOwner.set(row.ownerWorkspaceId, await ports.missions(row.ownerWorkspaceId).catch(() => null));
    const mission = byOwner.get(row.ownerWorkspaceId)?.get(row.id);
    if (!mission || mission.detached === true || !taskFolderKind(mission.folder, mission.branch, origin.botId, ports.roots)) continue;
    const key = path.resolve(mission.folder);
    if (seen.has(key) || !exists(key)) continue;
    seen.add(key);
    out.folders++;
    out.bytes += await folderBytes(key);
    if (ports.store.get(row.id)?.state === 'kept_dirty') out.dirty++;
  }
  // A folder a stop kept counts once, though its row is gone.
  for (const rec of keptRecords(ports.store)) {
    if (!rec.stopped || !taskFolderKind(rec.path, rec.branch, rec.stopped.botId, ports.roots)) continue;
    const key = path.resolve(rec.path);
    if (seen.has(key) || !exists(key)) continue;
    seen.add(key);
    out.folders++;
    out.bytes += await folderBytes(key);
    if (rec.state === 'kept_dirty') out.dirty++;
  }
  return out;
}

/** Install the automatic pass: on a bot task's end, on `kick` (a workspace
 *  closed) and every `retryMs`, over the tasks that ended in the last day
 *  and the folders put back for a resume. One pass at a time. Returns the
 *  unsubscribe. */
export function installTaskFolderCleanup(ports: TaskFolderPorts & {
  onTransition: (fn: (t: { entry: LedgerEntry; to: string }) => void) => () => void;
  allRows: () => LedgerEntry[];
  retryMs?: number;
}): { kick: () => void; dispose: () => void } {
  const now = ports.now ?? Date.now;
  const attempts = new Map<string, number>();
  let running = false;
  let again = false;
  const pass = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        let rows: LedgerEntry[] = [];
        try {
          rows = ports.allRows();
        } catch {
          rows = [];
        }
        const since = now() - TASK_FOLDER_CATCHUP_MS;
        const due = rows.filter((r) => {
          if (!isEndedBotTask(r)) return false;
          const rec = ports.store.get(r.id);
          if (rec && rec.state !== 'restored' && rec.state !== 'removing') return false;
          // A task the owner stopped whose resumed worker stopped again since
          // its row last changed: its folder is recorded at that stop.
          const restopped = isStoppedByOwnerRow(r) && ports.workerState(r.id) === 'stopped' && (ports.workerStoppedAt?.(r.id) ?? -Infinity) > r.updatedAt;
          if (!rec && r.updatedAt < since && !restopped) return false;
          return (attempts.get(`${r.id}@${r.rev}`) ?? 0) < TASK_FOLDER_ATTEMPTS_MAX;
        });
        // Folders a stop kept that have sat out their TTL (found by their
        // record: the ledger has usually pruned the row by then).
        // A kept folder whose resumed worker stopped again: its 7 days start
        // at that stop.
        for (const rec of ports.store.all()) {
          if (rec.state !== 'kept_stopped' || ports.workerState(rec.taskId) !== 'stopped') continue;
          const stopAt = ports.workerStoppedAt?.(rec.taskId);
          if (stopAt !== undefined && stopAt > rec.at) await ports.store.put({ ...rec, at: stopAt }).catch(() => undefined);
        }
        const expired = ports.store.all().filter((rec) => rec.state === 'kept_stopped' && !!rec.stopped
          && now() - rec.at >= TASK_FOLDER_KEPT_TTL_MS && (attempts.get(`${rec.taskId}@kept`) ?? 0) < TASK_FOLDER_ATTEMPTS_MAX);
        if (due.length === 0 && expired.length === 0) break;
        let sessions: TaskFolderSession[];
        try {
          sessions = await ports.listSessions();
        } catch {
          break;
        }
        const byOwner = new Map<string, Map<string, TaskMission> | null>();
        for (const row of due) {
          if (!byOwner.has(row.ownerWorkspaceId)) byOwner.set(row.ownerWorkspaceId, await ports.missions(row.ownerWorkspaceId).catch(() => null));
          const missions = byOwner.get(row.ownerWorkspaceId);
          if (!missions) continue;
          const r = await cleanTaskFolder(ports, row, missions.get(row.id) ?? null, sessions);
          if (r === 'failed') {
            const key = `${row.id}@${row.rev}`;
            attempts.set(key, (attempts.get(key) ?? 0) + 1);
          }
        }
        for (const rec of expired) {
          // Its mission, read from the daemon (detached missions outlive the
          // row), says where the folder is and whether it was handed to the
          // owner; only a mission gone too leaves the record to say where.
          // A record that does not name its owner workspace is left to
          // Clean up now.
          const live = rows.find((r) => r.id === rec.taskId);
          // A row that is open again is its task's, not a kept folder's.
          if (live && !isEndedBotTask(live)) continue;
          const owner = live?.ownerWorkspaceId || rec.stopped?.workspaceId;
          if (!owner) continue;
          if (!byOwner.has(owner)) byOwner.set(owner, await ports.missions(owner).catch(() => null));
          const missions = byOwner.get(owner);
          if (!missions) continue;
          const mission: TaskMission | null = missions.get(rec.taskId)
            ?? (live ? null : { folder: rec.path, ...(rec.branch ? { branch: rec.branch } : {}) });
          const r = await cleanTaskFolder(ports, live ?? keptRow(rec), mission, sessions, { keptTtl: true });
          if (r === 'failed') {
            const key = `${rec.taskId}@kept`;
            attempts.set(key, (attempts.get(key) ?? 0) + 1);
          }
        }
      } while (again);
    } finally {
      running = false;
    }
  };
  const kick = (): void => {
    void pass().catch((err) => (ports.log ?? console.warn)(`[factory] task folder pass failed: ${String(err)}`));
  };
  const off = ports.onTransition((t) => {
    if (isEndedBotTask({ status: t.to as LedgerEntry['status'], dispatch: t.entry.dispatch })) kick();
  });
  kick();
  let timer: ReturnType<typeof setInterval> | null = null;
  if (ports.retryMs && ports.retryMs > 0) {
    timer = setInterval(kick, ports.retryMs);
    timer.unref?.();
  }
  return {
    kick,
    dispose: () => {
      off();
      if (timer) clearInterval(timer);
    },
  };
}

const execFileAsync = promisify(execFile);

/** A worktree's main repository root (the parent of its common git dir),
 *  the hash TaskWorktreeManager keys its repository lock by (the root's
 *  realpath, sha256, 12 characters) and its HEAD commit. Null when git
 *  cannot tell. */
export async function gitRepoInfo(worktreePath: string): Promise<{ repoRoot: string; repoHash: string; head?: string } | null> {
  try {
    const opts = { cwd: worktreePath, timeout: 30_000, windowsHide: true, env: getExecEnv() };
    const common = (await execFileAsync('git', ['rev-parse', '--git-common-dir'], opts)).stdout.trim();
    if (!common) return null;
    const top = (await execFileAsync('git', ['-C', path.dirname(path.resolve(worktreePath, common)), 'rev-parse', '--show-toplevel'], opts)).stdout.trim();
    if (!top) return null;
    let real = top;
    try {
      real = fs.realpathSync(top);
    } catch {
      /* hashed as given */
    }
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], opts).catch(() => ({ stdout: '' }))).stdout.trim();
    return { repoRoot: top, repoHash: crypto.createHash('sha256').update(real).digest('hex').slice(0, 12), ...(/^[0-9a-f]{40,64}$/.test(head) ? { head } : {}) };
  } catch {
    return null;
  }
}

/** The ref namespace that holds commits of removed detached worktrees. */
export const TASK_KEEP_REF_PREFIX = 'refs/wmux/keep/';

/**
 * Before a task worktree goes: when its HEAD is detached (or the mission
 * names no branch), differs from the commit it was checked out at, and no ref
 * contains it, point `refs/wmux/keep/<taskId>` at it so its commits stay
 * reachable. Returns that ref when it was written, '' when nothing needed
 * keeping, and null when git could not tell (the worktree then stays).
 */
export async function keepDetachedCommits(
  repoRoot: string,
  worktreePath: string,
  taskId: string,
  branch: string | undefined,
  head: string | undefined,
  checkedOutAt: string | undefined,
): Promise<string | null> {
  const opts = { timeout: 30_000, windowsHide: true, env: getExecEnv() };
  if (branch) {
    // On its branch, the branch holds the commits.
    const onBranch = await execFileAsync('git', ['-C', worktreePath, 'symbolic-ref', '-q', 'HEAD'], opts).then(() => true, () => false);
    if (onBranch) return '';
  }
  if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return null;
  if (head === checkedOutAt) return '';
  try {
    const holders = (await execFileAsync('git', ['-C', repoRoot, 'for-each-ref', '--count=1', '--format=%(refname)', '--contains', head], opts)).stdout.trim();
    if (holders) return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) return null;
    const ref = `${TASK_KEEP_REF_PREFIX}${taskId}`;
    await execFileAsync('git', ['-C', repoRoot, 'update-ref', ref, head], opts);
    return ref;
  } catch {
    return null;
  }
}

// ── The host's ports, for the resume and Settings › Bots ───────────────────

let current: TaskFolderPorts & { allRows: () => LedgerEntry[] } | null = null;

/** Set by the worker lifecycle host on start (null on dispose). */
export function setTaskFolderPorts(next: TaskFolderPorts & { allRows: () => LedgerEntry[] } | null): void {
  current = next;
}

export function getTaskFolderPorts(): TaskFolderPorts & { allRows: () => LedgerEntry[] } | null {
  return current;
}
