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

/** A survivor of an earlier stop, or (`sessionId`) a pane whose destroy
 *  failed or timed out: what became of its tree is not known. */
type Lingering = TreeKillSurvivor & { sessionId?: string };

/**
 * Processes of a folder's panes that outlived an earlier stop, by folder.
 * Their sessions are gone by then, so a later stop of the same folder finds
 * no session to report them: it checks these instead, and keeps the folder
 * while one still runs. A pane whose destroy did not answer counts until a
 * later stop finds its session still there to destroy again. Held for the
 * life of the app.
 */
const lingering = new Map<string, Lingering[]>();

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
  constructor(readonly pids: number[], reasons: string[] = []) {
    super(`${pids.length} process(es) started in the worktree are still running${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`);
    this.name = 'PanesStillRunningError';
  }
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
  const sessions = await port.listSessions();
  const earlier = lingering.get(key);
  if (earlier) {
    // A pane whose destroy did not answer and that is still there is
    // destroyed again below, and answers then.
    const listed = new Set(sessions.map((s) => s.id));
    const open = earlier.filter((x) => !(x.sessionId && listed.has(x.sessionId)));
    // Both checks hand back entries of the list they were given.
    const still = (await (port.stillRunning ?? survivorsStillRunning)(open)) as Lingering[];
    if (still.length > 0) {
      // A pane whose destroy did not answer and is listed again stays
      // recorded until it is destroyed with an answer.
      lingering.set(key, [...still, ...earlier.filter((x) => !open.includes(x))]);
      throw new PanesStillRunningError(still.map((x) => x.pid), still.map((x) => `${x.pid}: ${x.sessionId ? x.reason : 'still running since an earlier stop'}`));
    }
    lingering.delete(key);
  }
  const inside = sessions.filter((s) => typeof s.spawnCwd === 'string' && s.spawnCwd.length > 0
    && isInside(sessionHostDir(s.spawnCwd, s, platform), dir, port, platform));
  const unknown = sessions.filter((s) => !s.spawnCwd).length;
  if (unknown > 0) port.log?.(`[worktask] ${unknown} session(s) have no spawn directory recorded; left running`);

  const treeSurvivors: Lingering[] = [];
  const unreported: number[] = [];
  for (const s of inside) {
    let tree: DaemonDestroySessionTree | void;
    try {
      tree = await port.destroySession(s.id);
    } catch (err) {
      // The daemon may have destroyed the pane and still be killing its
      // tree: until a later stop sees the session again, it counts.
      lingering.set(key, [...treeSurvivors, { pid: s.pid ?? 0, sessionId: s.id, unverified: true, reason: `the stop of pane ${s.id} did not finish (${(err as Error).message})` }]);
      throw err;
    }
    if (tree) {
      if (!tree.ok) {
        treeSurvivors.push(...tree.survivors);
        // Kept before the next destroy: if that one throws, this pane is
        // already gone and only this record still names its survivors.
        lingering.set(key, [...treeSurvivors]);
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
  if (survivors.length > 0) throw new PanesStillRunningError(survivors.map((x) => x.pid), survivors.map((x) => `${x.pid}: ${x.reason}`));
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
