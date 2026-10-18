// Kill a process tree and KNOW it is gone (#2388).
//
// treeKill.ts sends the signals and returns; nothing says whether every
// process in the tree exited. A caller that removes a folder afterwards (a
// task worktree) needs that answer: on Windows a process still running in the
// folder, or holding a file there, makes the delete fail part way. So this
// helper takes the tree in two steps:
//   1. capture, while the root is still alive (before the PTY is destroyed,
//      which would orphan the tree): every descendant found and pinned;
//   2. kill: everything captured, plus any child a captured process started
//      since, and then wait until each one has exited. Whatever has not by
//      the deadline is reported as a survivor; the caller fails closed.
//
// Windows: a handle is opened on every process in the tree. A held handle
// keeps Windows from handing the pid to another process, so the ppid walk
// in later rounds cannot reach an unrelated process through a reused pid,
// and "exited" is read from the handle (signaled), not from the pid: an
// exited process whose handle someone still holds keeps its pid. Windows
// never re-parents an orphan, so a process whose ppid names one of ours
// is ours only if it was created no earlier than that process (the rule
// collectTreeCpuTimes in winSnapshotNative.ts applies) and no later than the
// moment the table was asked for: a process on a pid the table had for one
// that exited since was created after that.
//
// POSIX: the tree is frozen (SIGSTOP, rescanning until no new descendant
// appears, as killProcessTreePosix does), so nothing in it can fork or exit
// before the kill; a frozen process keeps its pid. After SIGKILL, each pid
// is polled until it is gone or a zombie (which holds no files), its start
// time compared so a reused pid is not mistaken for a survivor's absence.
//
// Not covered, by construction: a process that left the tree before the
// capture (a POSIX daemon re-parented to init, a Windows process whose
// parent had already exited and been released), and the Linux side of a WSL
// pane, which the Windows process table does not show. Kept independent of
// any caller (the worktree removal, a future Job Object, #2398).

import { execFile } from 'node:child_process';
import { collectDescendants } from './treeKill';
import { dmtfToUtcMicros, sameProcessStartTime } from '../phantomExit';
import { tryProcessHandleApi, type ProcessHandle, type ProcessHandleApi } from '../../main/pty/winSnapshotNative';

/** A process of the tree that did not exit, and why. */
export interface TreeKillSurvivor {
  pid: number;
  reason: string;
  /** Its creation time (Windows: FILETIME; POSIX: `lstart`), when it was
   *  identified: what survivorsStillRunning checks it by later. */
  startTime?: string;
  /** Not a process seen running: the tree under `pid` could not be checked
   *  whole (the table unreadable, still growing). Whatever was missed cannot
   *  be checked later either, so survivorsStillRunning always keeps it. */
  unverified?: true;
}

export type VerifiedTreeKillResult =
  | { ok: true; killed: number[] }
  | { ok: false; killed: number[]; survivors: TreeKillSurvivor[] };

/** A process tree captured while its root was alive. */
export interface CapturedTree {
  readonly rootPid: number;
  /** The pids captured so far, root first. */
  pids(): number[];
  /** Kill everything captured and every child a captured process started
   *  since, then wait (up to `timeoutMs`) until each has exited. Releases
   *  what the capture held; call once. */
  kill(opts?: { timeoutMs?: number }): Promise<VerifiedTreeKillResult>;
  /** Release what the capture held without killing anything. */
  release(): void;
}

/** How long kill() waits for the tree to exit. */
export const VERIFIED_TREE_KILL_TIMEOUT_MS = 5000;
const POLL_MS = 50;
/** Capture rounds (rescans of the process table) before giving up on a tree
 *  that keeps growing. */
export const CAPTURE_ROUNDS = 8;

export interface CaptureOptions {
  /** Whether the root found at the pid is the process the caller means:
   *  given the root's creation time (Windows: FILETIME; POSIX: `ps -o
   *  lstart=`), false when it is another one (the pid was reused). Null or
   *  absent: not known, taken as the caller's. */
  rootIsOurs?: (startTime: string) => boolean | null;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A {@link CaptureOptions.rootIsOurs} from a start time recorded at spawn
 * (a session's `pidStartTime`): equal readings name the same process.
 * Windows records a FILETIME, or (before #2398) CIM's DMTF string, which is
 * compared in UTC microseconds (sameProcessStartTime). POSIX `lstart` pads a
 * one-digit day with a second space, so runs of spaces compare as one. Null
 * (unknown) when nothing was recorded or the record is in neither format.
 */
export function matchesRecordedStart(recorded: string | undefined, current: string): boolean | null {
  if (!recorded) return null;
  if (process.platform === 'win32') {
    if (!/^\d+$/.test(recorded) && dmtfToUtcMicros(recorded) === null) return null;
    return sameProcessStartTime(recorded, current);
  }
  return recorded.trim().replace(/\s+/g, ' ') === current.trim().replace(/\s+/g, ' ');
}

/**
 * The start time a session recorded for its pid, in the form
 * matchesRecordedStart compares: Windows records the FILETIME
 * (`pidCreatedAtFt`, #2398), and `pidStartTime` holds the POSIX `lstart` or
 * a Windows record from before that.
 */
export function recordedStartOf(
  meta: { pidCreatedAtFt?: string; pidStartTime?: string },
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === 'win32' ? meta.pidCreatedAtFt ?? meta.pidStartTime : meta.pidStartTime;
}

/**
 * The survivors of an earlier kill that still run: the same process (its
 * start time compared) and not exited. One that cannot be read counts as
 * running, and so does an unverified tree, so a caller keeps what it guards.
 * Never throws.
 */
export async function survivorsStillRunning(survivors: readonly TreeKillSurvivor[]): Promise<TreeKillSurvivor[]> {
  if (survivors.length === 0) return [];
  const unverified = survivors.filter((s) => s.unverified);
  const seen = await processesStillRunning(survivors.filter((s) => !s.unverified));
  return [...unverified, ...seen];
}

async function processesStillRunning(survivors: readonly TreeKillSurvivor[]): Promise<TreeKillSurvivor[]> {
  if (survivors.length === 0) return [];
  if (process.platform === 'win32') {
    const api = tryProcessHandleApi();
    if (!api) return [...survivors];
    return survivors.filter((s) => {
      const now = api.open(s.pid);
      if ('gone' in now) return false;
      if ('failure' in now) return true;
      try {
        if (s.startTime !== undefined && now.createdAt.toString() !== s.startTime) return false;
        return api.hasExited(now.handle) !== true;
      } finally {
        api.close(now.handle);
      }
    });
  }
  let rows: PosixProcRow[];
  try {
    rows = await defaultPosixDeps.listProcesses();
  } catch {
    return [...survivors];
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return survivors.filter((s) => {
    const row = byPid.get(s.pid);
    if (!row || row.stat.startsWith('Z')) return false;
    return s.startTime === undefined || row.start === s.startTime;
  });
}

/**
 * Capture the tree rooted at `rootPid`. Null when the root is gone already
 * (or is not the caller's process): there is no tree to take. Never throws.
 */
export async function captureProcessTree(rootPid: number, opts: CaptureOptions = {}): Promise<CapturedTree | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return null;
  if (process.platform === 'win32') {
    const api = tryProcessHandleApi();
    // Without the native path nothing can be pinned or verified: fail closed.
    if (!api) return failedCapture(rootPid, 'native process access is unavailable');
    return captureTreeWin32(rootPid, api, opts);
  }
  return captureTreePosix(rootPid, defaultPosixDeps, opts);
}

/** Capture and kill in one step (the root must still be alive). */
export async function killProcessTreeVerified(
  rootPid: number,
  opts: CaptureOptions & { timeoutMs?: number } = {},
): Promise<VerifiedTreeKillResult> {
  const tree = await captureProcessTree(rootPid, opts);
  return tree ? tree.kill({ timeoutMs: opts.timeoutMs }) : { ok: true, killed: [] };
}

/** A capture that could not see the tree: its kill reports the root as a
 *  survivor, so the caller keeps whatever it guards. */
function failedCapture(rootPid: number, reason: string): CapturedTree {
  return {
    rootPid,
    pids: () => [rootPid],
    kill: async () => ({ ok: false, killed: [], survivors: [{ pid: rootPid, reason, unverified: true }] }),
    release: () => undefined,
  };
}

// ─── Windows ────────────────────────────────────────────────────────────────

interface WinTracked {
  pid: number;
  handle: ProcessHandle;
  createdAt: bigint;
  canTerminate: boolean;
}

/** Exported for tests, with a fake {@link ProcessHandleApi}. */
export function captureTreeWin32(rootPid: number, api: ProcessHandleApi, opts: CaptureOptions = {}): CapturedTree | null {
  const sleep = opts.sleep ?? defaultSleep;
  const root = api.open(rootPid);
  if ('gone' in root) return null;
  if ('failure' in root) return failedCapture(rootPid, `the root could not be opened: ${root.failure}`);
  if (opts.rootIsOurs?.(root.createdAt.toString()) === false) {
    api.close(root.handle);
    return null;
  }
  const tracked = new Map<number, WinTracked>([[rootPid, { pid: rootPid, ...root }]]);
  /** Processes whose ppid names one of ours but that could not be identified. */
  const unidentified = new Map<number, string>();
  /** A process of the table that exited before it could be opened, or could
   *  not be identified, while it had children there: they cannot be told
   *  from strangers (nothing pins its pid), so the tree is not known whole. */
  const lostParents = new Set<number>();
  let released = false;

  /** One rescan: adds every new process of the tree. Returns how many were
   *  added; throws when the table cannot be read. */
  const scan = (): number => {
    // Taken before the table: every process the table lists was created by
    // then, unless it is a later process on a pid the table had for another.
    const askedAt = api.now();
    const table = api.processTable();
    const children = new Map<number, number[]>();
    for (const { pid, ppid } of table) {
      if (pid === ppid) continue;
      const list = children.get(ppid);
      if (list) list.push(pid);
      else children.set(ppid, [pid]);
    }
    let added = 0;
    const queue = [...tracked.values()];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const pid of children.get(parent.pid) ?? []) {
        if (tracked.has(pid)) continue;
        const opened = api.open(pid);
        if ('gone' in opened) {
          if ((children.get(pid) ?? []).some((c) => !tracked.has(c))) lostParents.add(pid);
          continue;
        }
        if ('failure' in opened) {
          // Its ppid names one of ours, pinned, so it is ours or an orphan
          // older than the process now holding that pid: unknown either way.
          // Its children are not walked, so with any in the table the tree
          // is not known whole even once it exits.
          unidentified.set(pid, `could not be identified: ${opened.failure}`);
          if ((children.get(pid) ?? []).some((c) => !tracked.has(c))) lostParents.add(pid);
          continue;
        }
        // Older than its "parent": an orphan whose dead parent's pid went to
        // one of ours. Newer than the table: a later process on a pid the
        // table had for an exited one (a real child that new is taken by the
        // next scan, whose table lists it).
        if (opened.createdAt < parent.createdAt || opened.createdAt > askedAt) {
          api.close(opened.handle);
          continue;
        }
        unidentified.delete(pid);
        const t: WinTracked = { pid, ...opened };
        tracked.set(pid, t);
        queue.push(t);
        added++;
      }
    }
    return added;
  };

  let scanError: string | null = null;
  const tryScan = (): number => {
    try {
      return scan();
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      return 0;
    }
  };
  for (let round = 0; round < CAPTURE_ROUNDS && tryScan() > 0; round++) { /* grow until stable */ }

  const release = (): void => {
    if (released) return;
    released = true;
    for (const t of tracked.values()) api.close(t.handle);
  };

  const exited = (t: WinTracked): boolean => api.hasExited(t.handle) === true;

  return {
    rootPid,
    pids: () => [...tracked.keys()],
    release,
    kill: async ({ timeoutMs = VERIFIED_TREE_KILL_TIMEOUT_MS } = {}) => {
      if (released) return { ok: false, killed: [], survivors: [{ pid: rootPid, reason: 'the capture was released', unverified: true }] };
      const deadline = Date.now() + timeoutMs;
      const refused = new Map<number, string>();
      try {
        // Parents first, so a parent stops starting children as early as
        // possible; a child it started meanwhile is found by the rescan.
        const terminateAll = (): void => {
          for (const t of tracked.values()) {
            if (exited(t) || refused.has(t.pid)) continue;
            if (!t.canTerminate) refused.set(t.pid, 'access denied (another user\'s or an elevated process)');
            else if (!api.terminate(t.handle) && !exited(t)) refused.set(t.pid, 'TerminateProcess failed');
          }
        };
        terminateAll();
        let settled = false;
        for (;;) {
          // Settled when every captured process has exited and a table read
          // after that shows no child of theirs: an exited process starts
          // nothing, so none can appear later.
          const allExited = [...tracked.values()].every(exited);
          const added = tryScan();
          if (added > 0) terminateAll();
          if (added === 0 && allExited) {
            settled = true;
            break;
          }
          if (Date.now() >= deadline) break;
          if (added === 0) await sleep(POLL_MS);
        }
        const survivors: TreeKillSurvivor[] = [];
        for (const t of tracked.values()) {
          if (exited(t)) continue;
          survivors.push({ pid: t.pid, reason: refused.get(t.pid) ?? 'still running', startTime: t.createdAt.toString() });
        }
        for (const pid of lostParents) {
          unidentified.delete(pid);
          survivors.push({ pid, reason: 'it exited before its children could be identified; they may still run', unverified: true });
        }
        // Still there and still not identified (one that exited meanwhile is
        // no longer a question).
        for (const [pid, reason] of unidentified) {
          const now = api.open(pid);
          if ('gone' in now) continue;
          if ('handle' in now) api.close(now.handle);
          survivors.push({ pid, reason });
        }
        // The tree was still growing at the deadline: a child started last may
        // not have been seen.
        if (!settled && survivors.length === 0) survivors.push({ pid: rootPid, reason: 'the tree kept starting processes until the deadline', unverified: true });
        const killed = [...tracked.values()].filter(exited).map((t) => t.pid);
        if (scanError !== null) survivors.push({ pid: rootPid, reason: `the process table could not be read: ${scanError}`, unverified: true });
        return survivors.length === 0 ? { ok: true, killed } : { ok: false, killed, survivors };
      } finally {
        release();
      }
    },
  };
}

// ─── POSIX ──────────────────────────────────────────────────────────────────

/** One row of `ps -axo pid=,ppid=,stat=,lstart=`. */
export interface PosixProcRow {
  pid: number;
  ppid: number;
  /** Process state; a zombie starts with `Z`. */
  stat: string;
  /** `lstart`: the start time, as the daemon records a session's pid. */
  start: string;
}

export interface PosixTreeDeps {
  /** The process table; throws when it cannot be read. */
  listProcesses(): Promise<PosixProcRow[]>;
  signal(pid: number, sig: NodeJS.Signals): void;
}

export function parsePsIdentityRows(output: string): PosixProcRow[] {
  const rows: PosixProcRow[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], start: m[4].replace(/\s+/g, ' ') });
  }
  return rows;
}

const defaultPosixDeps: PosixTreeDeps = {
  listProcesses: () =>
    new Promise((resolve, reject) => {
      // The daemon's own environment, as getProcessStartTime reads a
      // session's `lstart`: the same locale gives the same words.
      execFile('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => {
        if (error) reject(error);
        else resolve(parsePsIdentityRows(output ?? ''));
      });
    }),
  signal: (pid, sig) => process.kill(pid, sig),
};

/** Exported for tests, with fake {@link PosixTreeDeps}. */
export async function captureTreePosix(rootPid: number, deps: PosixTreeDeps, opts: CaptureOptions = {}): Promise<CapturedTree | null> {
  const sleep = opts.sleep ?? defaultSleep;
  const send = (pid: number, sig: NodeJS.Signals): boolean => {
    try {
      deps.signal(pid, sig);
      return true;
    } catch {
      /* already gone, or not ours to signal */
      return false;
    }
  };
  let rows: PosixProcRow[];
  try {
    rows = await deps.listProcesses();
  } catch (err) {
    return failedCapture(rootPid, `the process table could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rootRow = rows.find((r) => r.pid === rootPid);
  if (!rootRow || rootRow.stat.startsWith('Z')) return null;
  if (opts.rootIsOurs?.(rootRow.start) === false) return null;
  /** pid → start time, in discovery order (parents before children). */
  const targets = new Map<number, string>();
  let scanError: string | null = null;
  let complete = false;
  const unfrozen: number[] = [];
  for (let round = 0; round < CAPTURE_ROUNDS; round++) {
    if (round > 0) {
      try {
        rows = await deps.listProcesses();
      } catch (err) {
        scanError = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    let added = 0;
    for (const pid of collectDescendants(rows.map((r) => [r.pid, r.ppid] as const), rootPid)) {
      if (targets.has(pid)) continue;
      const row = byPid.get(pid);
      if (!row) continue;
      targets.set(pid, row.start);
      // One that cannot be frozen (another user's, a setuid program) can
      // still fork and exit, leaving a child the tree no longer leads to.
      if (!send(pid, 'SIGSTOP')) unfrozen.push(pid);
      added++;
    }
    if (added === 0) {
      complete = true;
      break;
    }
  }
  // Still finding new processes in the last round: one of them may have
  // forked before it was frozen, into a process group the kill misses.
  if (!complete && scanError === null) scanError = `the tree was still growing after ${CAPTURE_ROUNDS} scans`;
  if (unfrozen.length > 0 && scanError === null) scanError = `process(es) ${unfrozen.join(', ')} could not be frozen`;
  let released = false;
  /** The captured pids still held by the processes captured (their start
   *  time unchanged), in capture order. A frozen process cannot exit, but
   *  another process can kill it and its pid go to an unrelated one; that
   *  one is never signalled. When the table cannot be read, all of them:
   *  frozen, they keep their pids. */
  const stillCaptured = async (): Promise<number[]> => {
    try {
      const byPid = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
      return [...targets].filter(([pid, start]) => byPid.get(pid)?.start === start).map(([pid]) => pid);
    } catch {
      return [...targets.keys()];
    }
  };
  return {
    rootPid,
    pids: () => [...targets.keys()],
    release: () => {
      if (released) return;
      released = true;
      void stillCaptured().then((pids) => {
        for (const pid of pids) send(pid, 'SIGCONT');
      });
    },
    kill: async ({ timeoutMs = VERIFIED_TREE_KILL_TIMEOUT_MS } = {}) => {
      if (released) return { ok: false, killed: [], survivors: [{ pid: rootPid, reason: 'the capture was released', unverified: true }] };
      released = true;
      const ours = await stillCaptured();
      // Leaves first (discovery order is parent-before-child), then the PTY's
      // process group (the root is a session leader) and the root, while the
      // root is still the one captured (its group is then still its own).
      for (const pid of [...ours].reverse()) send(pid, 'SIGKILL');
      if (ours.includes(rootPid)) {
        send(-rootPid, 'SIGKILL');
        send(rootPid, 'SIGKILL');
      }
      const deadline = Date.now() + timeoutMs;
      let alive: TreeKillSurvivor[] = [];
      for (;;) {
        try {
          const byPid = new Map((await deps.listProcesses()).map((r) => [r.pid, r]));
          alive = [...targets].flatMap(([pid, start]) => {
            const row = byPid.get(pid);
            return row && row.start === start && !row.stat.startsWith('Z') ? [{ pid, reason: 'still running', startTime: start }] : [];
          });
        } catch (err) {
          alive = [...targets.keys()].map((pid) => ({ pid, reason: `the process table could not be read: ${err instanceof Error ? err.message : String(err)}` }));
        }
        if (alive.length === 0 || Date.now() >= deadline) break;
        await sleep(POLL_MS);
      }
      const survivors = [...alive];
      if (scanError !== null) survivors.push({ pid: rootPid, reason: `the tree could not be taken whole: ${scanError}`, unverified: true });
      const killed = [...targets.keys()].filter((pid) => !alive.some((s) => s.pid === pid));
      return survivors.length === 0 ? { ok: true, killed } : { ok: false, killed, survivors };
    },
  };
}
