// Stop the panes that were started inside a task worktree before it is removed.
//
// A shell or agent running in the worktree holds file handles, and on Windows
// `git worktree remove` then deregisters the worktree but leaves part of the
// folder behind. Task panes live in the daemon, so the sessions are found and
// destroyed there, each with its whole process tree (`killTree`, #2388: the
// shell's children, an agent and its tools, would otherwise outlive it), and
// the removal goes ahead only once the daemon has checked every one exited.
//
// Only `spawnCwd` decides: `cwd` comes from OSC 7, i.e. whatever a program in
// the pane printed, and must never pick what gets killed (daemon/types.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeWorktreePath } from '../../shared/workTask';
import type { DaemonDestroySessionTree } from '../../shared/rpc';
import { wslPathToHost } from '../../mcp/wslPaths';
import { survivorsStillRunning, type TreeKillSurvivor } from '../../daemon/automation/verifiedTreeKill';

export interface SessionsInDirPort {
  listSessions(): Promise<Array<{ id: string; pid?: number; spawnCwd?: string; wslTarget?: { distribution?: unknown } }>>;
  /** Destroy the session and its whole process tree (`daemon.destroySession`
   *  with `killTree`): answers whether every process of the tree exited. No
   *  answer (a daemon from before `killTree`): only its shell is waited for. */
  destroySession(id: string): Promise<DaemonDestroySessionTree | void>;
  /** Whether `pid` is still running. */
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Canonical path (symlinks resolved) when it exists; the resolved input otherwise. */
  realpath?(p: string): string;
  log?(message: string): void;
  platform?: NodeJS.Platform;
  /** Which of an earlier stop's survivors still run (default:
   *  survivorsStillRunning). */
  stillRunning?(survivors: readonly TreeKillSurvivor[]): Promise<TreeKillSurvivor[]>;
}

/** What an earlier stop of a folder left to check, its sessions gone. */
interface FolderRecord {
  /** Processes to look at again, by pid and (when known) start time: the
   *  identified survivors, and every process a kill that could not be
   *  verified had taken. */
  check: TreeKillSurvivor[];
  /** Why that kill could not be verified, when it could not. */
  unverified?: string;
}

/**
 * What earlier stops of a folder left, by folder. A stop destroys the panes'
 * sessions, so a later stop finds no session to capture from: it checks the
 * recorded processes instead (on Windows, also what each one started before
 * it exited) and keeps the folder until that check is positive, every one
 * gone. A record with nothing to check (a kill that took no process) is
 * never cleared by a check. Close and keep folder (keepFolder) ends a record. Held for
 * the life of the app.
 */
const lingering = new Map<string, FolderRecord>();

/** How a refusal that only a later check or Close and keep folder can end says so. */
export const STOP_ESCAPE_HINT = 'close it again once they have exited, or use Close and keep folder to close the task and keep its files';

/** Close and keep folder (keepFolder): forget what earlier stops of `dir` left. */
export function forgetFolderStops(dir: string, port: Pick<SessionsInDirPort, 'realpath' | 'platform'> = {}): void {
  lingering.delete(normalizeWorktreePath((port.realpath ?? defaultRealpath)(dir), port.platform ?? process.platform));
}

/**
 * Stops under way, by folder. A stop destroys its sessions before it knows
 * whether their trees exited, so another stop of the same folder (a bot
 * worker stop and a task close at once) would find no session and go ahead:
 * it waits for these first, and then sees what they left in `lingering`.
 */
const inFlight = new Map<string, Promise<unknown>>();
/** Counts registrations in `inFlight`, so a check can tell whether a stop
 *  started while it was listing. */
let stopsStarted = 0;

/** The stops under way in `key`, in a folder inside it, or in one holding
 *  it, as one promise that settles when they all have. Taken synchronously,
 *  so a stop that registers right after is never missed. */
function stopsAround(key: string): Promise<void> {
  const overlapping = [...inFlight].filter(([k]) => k === key || k.startsWith(key + '/') || key.startsWith(k + '/')).map(([, p]) => p);
  return Promise.all(overlapping.map((p) => p.catch(() => undefined))).then(() => undefined);
}

/** The survivors worth checking again later: identified processes only. */
function identified(survivors: readonly TreeKillSurvivor[]): TreeKillSurvivor[] {
  return survivors.filter((x) => !x.unverified && x.startTime !== undefined);
}

/** Add what a pane's kill left to the folder's record. */
function recordTree(key: string, tree: { survivors: TreeKillSurvivor[]; captured?: Array<{ pid: number; startTime: string }> }): void {
  const prior = lingering.get(key) ?? { check: [] };
  const check = [...prior.check];
  const add = (x: TreeKillSurvivor): void => {
    if (!check.some((c) => c.pid === x.pid && c.startTime === x.startTime)) check.push(x);
  };
  for (const s of identified(tree.survivors)) add(s);
  const unverified = tree.survivors.filter((s) => s.unverified).map((s) => s.reason);
  if (unverified.length > 0) {
    for (const c of tree.captured ?? []) add({ pid: c.pid, startTime: c.startTime, reason: 'taken by a kill that could not be verified' });
  }
  const reasons = [prior.unverified, ...unverified].filter((r): r is string => !!r);
  if (check.length === 0 && reasons.length === 0) return;
  lingering.set(key, { check, ...(reasons.length > 0 ? { unverified: reasons.join('; ') } : {}) });
}

/** Check what earlier stops of the folder left: the record ends once every
 *  recorded process is gone; otherwise this throws and keeps it. */
async function checkEarlierStops(key: string, port: Pick<SessionsInDirPort, 'stillRunning'>): Promise<void> {
  const earlier = lingering.get(key);
  if (!earlier) return;
  if (earlier.check.length === 0) {
    throw new PanesStillRunningError([], [], [`an earlier stop could not verify its processes exited (${earlier.unverified ?? 'unknown'}) and took none to check again; use Close and keep folder to close the task and keep its files`]);
  }
  const still = await (port.stillRunning ?? survivorsStillRunning)(earlier.check);
  if (still.length === 0) {
    lingering.delete(key);
    return;
  }
  lingering.set(key, { ...earlier, check: still });
  const why = earlier.unverified ? ` (an earlier stop could not verify its processes exited: ${earlier.unverified})` : '';
  throw new PanesStillRunningError(still.map((x) => x.pid), [`still running since an earlier stop${why}; ${STOP_ESCAPE_HINT}`]);
}

/** Test seam: forget every earlier stop's survivors. */
export function resetLingeringSurvivors(): void {
  lingering.clear();
}

/** A destroy that kills and checks a pane's whole tree (the daemon's capture,
 *  kill and exit wait) is given this long before the RPC gives up. */
export const TREE_DESTROY_TIMEOUT_MS = 60_000;

const EXIT_WAIT_MS = 5000;
const EXIT_POLL_MS = 100;

export class PanesStillRunningError extends Error {
  constructor(readonly pids: number[], reasons: string[] = [], unverified: string[] = []) {
    const parts = [
      ...(pids.length > 0 ? [`${pids.length} process(es) started in the worktree are still running${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`] : []),
      ...(unverified.length > 0 ? [`could not verify all processes exited: ${unverified.join('; ')}`] : []),
    ];
    super(parts.join('; '));
    this.name = 'PanesStillRunningError';
  }
}

/** The error for survivors of a stop: processes still running, and trees
 *  that could not be checked whole. */
function survivorsError(survivors: readonly TreeKillSurvivor[]): PanesStillRunningError {
  const running = survivors.filter((x) => !x.unverified);
  const unverified = survivors.filter((x) => x.unverified).map((x) => x.reason);
  if (unverified.length > 0) unverified[unverified.length - 1] += `; ${STOP_ESCAPE_HINT}`;
  return new PanesStillRunningError(running.map((x) => x.pid), running.map((x) => `${x.pid}: ${x.reason}`), unverified);
}

/** The tree in a `daemon.destroySession` reply, when the daemon sent one. */
export function destroyedTreeOf(reply: unknown): DaemonDestroySessionTree | undefined {
  const tree = (reply as { tree?: unknown } | null)?.tree as { ok?: unknown; survivors?: unknown } | undefined;
  if (!tree || typeof tree.ok !== 'boolean') return undefined;
  if (tree.ok === false && !Array.isArray(tree.survivors)) return undefined;
  return tree as DaemonDestroySessionTree;
}

function defaultRealpath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInside(dir: string, root: string, port: Pick<SessionsInDirPort, 'realpath'>, platform: NodeJS.Platform): boolean {
  const real = port.realpath ?? defaultRealpath;
  const d = normalizeWorktreePath(real(dir), platform);
  const r = normalizeWorktreePath(real(root), platform);
  return d === r || d.startsWith(r + '/');
}

/**
 * A session's directory as this process names it. A WSL pane records the
 * Linux path it was started in (`/mnt/c/…`, resolveWslCwd), which never
 * matches the Windows folder it is (#2254); on win32 no Windows path starts
 * with a single `/`, so such a path is translated. One that cannot be (a
 * distro path with no distro known) comes back as given.
 */
export function sessionHostDir(dir: string, session: { wslTarget?: { distribution?: unknown } }, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !dir.startsWith('/') || dir.startsWith('//')) return dir;
  const distro = typeof session.wslTarget?.distribution === 'string' ? session.wslTarget.distribution : undefined;
  const host = wslPathToHost(dir, distro);
  return 'path' in host ? host.path : dir;
}

/** Ids of the sessions started in any of `dirs` (or below them). */
export async function sessionsStartedIn(dirs: readonly string[], port: Pick<SessionsInDirPort, 'listSessions' | 'realpath' | 'platform'>): Promise<string[]> {
  const platform = port.platform ?? process.platform;
  const sessions = await port.listSessions();
  return sessions
    .filter((s) => typeof s.spawnCwd === 'string' && s.spawnCwd.length > 0
      && dirs.some((d) => isInside(sessionHostDir(s.spawnCwd as string, s, platform), d, port, platform)))
    .map((s) => s.id);
}

/**
 * Nothing runs in `dir` that a stop would have to end, checked without
 * stopping anything (the sweep at start, which must never close a pane the
 * owner just opened): no session was started in it, and no process an
 * earlier stop left is still running. Throws when one is.
 */
export async function assertNothingRunsIn(dir: string, port: Pick<SessionsInDirPort, 'listSessions' | 'realpath' | 'platform' | 'stillRunning'>): Promise<void> {
  const platform = port.platform ?? process.platform;
  const key = normalizeWorktreePath((port.realpath ?? defaultRealpath)(dir), platform);
  // A stop under way has taken its sessions off the list already: wait for
  // it, then list, so a pane opened meanwhile is seen too. A stop that starts
  // while the list is read takes its sessions off it: list again after it.
  for (let attempt = 0; ; attempt++) {
    const seen = stopsStarted;
    await stopsAround(key);
    const started = await sessionsStartedIn([dir], port);
    if (started.length > 0) throw new Error(`${started.length} pane(s) were started in the folder`);
    if (stopsStarted === seen) break;
    if (attempt >= 4) throw new Error('stops of the folder keep starting');
  }
  await checkEarlierStops(key, port);
}

/**
 * Destroy every daemon session that was started in `dir` or below it, each
 * with its process tree, and confirm every process exited (the daemon checks
 * the tree; a shell the daemon did not report on is waited for, up to 5 s).
 * Returns the ids it destroyed. Throws when a session cannot be destroyed or
 * a process is still running, so the caller keeps the worktree instead of
 * removing it half-way.
 */
export async function stopSessionsInDir(dir: string, port: SessionsInDirPort): Promise<string[]> {
  const platform = port.platform ?? process.platform;
  const key = normalizeWorktreePath((port.realpath ?? defaultRealpath)(dir), platform);
  const before = stopsAround(key);
  const run = before.then(() => stopNow(dir, key, platform, port));
  inFlight.set(key, run);
  stopsStarted++;
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

async function stopNow(dir: string, key: string, platform: NodeJS.Platform, port: SessionsInDirPort): Promise<string[]> {
  const sessions = await port.listSessions();
  await checkEarlierStops(key, port);
  const inside = sessions.filter((s) => typeof s.spawnCwd === 'string' && s.spawnCwd.length > 0
    && isInside(sessionHostDir(s.spawnCwd, s, platform), dir, port, platform));
  const unknown = sessions.filter((s) => !s.spawnCwd).length;
  if (unknown > 0) port.log?.(`[worktask] ${unknown} session(s) have no spawn directory recorded; left running`);

  const treeSurvivors: TreeKillSurvivor[] = [];
  const unreported: number[] = [];
  for (const s of inside) {
    const tree = await port.destroySession(s.id);
    if (tree) {
      if (!tree.ok) {
        treeSurvivors.push(...tree.survivors);
        // Kept before the next destroy: if that one throws, this pane is
        // already gone and only this record still names what it left.
        recordTree(key, tree);
      }
    } else if (typeof s.pid === 'number' && s.pid > 0) {
      unreported.push(s.pid);
    }
  }
  if (unreported.length > 0) port.log?.(`[worktask] the daemon did not report on ${unreported.length} pane process tree(s); only their shells are waited for`);

  for (let waited = 0; waited < EXIT_WAIT_MS && unreported.some((p) => port.isAlive(p)); waited += EXIT_POLL_MS) {
    await port.sleep(EXIT_POLL_MS);
  }
  const survivors = [...treeSurvivors, ...unreported.filter((p) => port.isAlive(p)).map((pid) => ({ pid, reason: 'still running' }))];
  if (survivors.length > 0) throw survivorsError(survivors);
  return inside.map((s) => s.id);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
