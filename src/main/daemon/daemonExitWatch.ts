/**
 * Main's record of how the daemon ended.
 *
 * The daemon logs every exit JS can see (src/daemon/exitEvidence.ts), but a
 * native fault ends the process before any JS runs: in #2398 a node-pty access
 * violation killed it with nothing in any log, and the exit code 0xC0000005 —
 * the one fact that named the cause — had to be dug out with a debugger. Main
 * is the process that outlives the daemon, so it writes that code down:
 *
 *   daemon pid 1234 exited 0xC0000005 (access violation) — at socket close
 *
 * Two sources, whichever answers:
 *  - the child 'exit' event, for a daemon this process spawned;
 *  - on Windows, a process handle opened when the daemon is installed. It must
 *    be open before the daemon dies: afterwards the exit code is gone and the
 *    pid may name another process.
 * A daemon found running on POSIX has neither; the line then says so.
 *
 * A graceful shutdown closes the pipe first and exits up to ~11 s later, so a
 * socket close starts a bounded poll. A daemon still running at its end is
 * logged as such: main dropped the connection to a live daemon.
 */

import { SHUTDOWN_KILL_EXIT_CODE } from '../../daemon/shutdownKill';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../../shared/constants';
import { onSpawnedDaemonExit, type SpawnedDaemonExit } from '../../shared/daemon/daemonLauncherCore';
import { tryOpenProcessExitHandle, type ProcessExitHandle } from '../pty/winSnapshotNative';

type Level = 'info' | 'warn' | 'error';

/** Descriptions for the exit codes a daemon has been seen to die with. */
const KNOWN_EXIT_CODES = new Map<number, string>([
  [0, 'clean exit'],
  [1, 'exit(1)'],
  [3, 'abort()'],
  // Node's own abort on Windows (a V8 heap out of memory, process.abort()):
  // Node exits 134 there, not the CRT's 3. On POSIX the same abort is SIGABRT,
  // which the `killed by` branch reports instead.
  [134, 'Node abort: out of memory or process.abort(); see the crash-reports folder'],
  [DAEMON_EXIT_ALREADY_RUNNING, 'another daemon already runs'],
  [0xc0000005, 'access violation'],
  [0xc0000017, 'out of memory'],
  [0xc00000fd, 'stack overflow'],
  [0xc000013a, 'Ctrl+C / Ctrl+Break'],
  [0xc0000374, 'heap corruption'],
  [0xc0000409, 'fail-fast / stack buffer overrun'],
  [SHUTDOWN_KILL_EXIT_CODE, 'terminated by a debugger or console close'],
  // Crashpad's own codes (crashpad/util/win/termination_codes.h). The daemon
  // runs on Electron's binary, whose Crashpad client can catch a native fault
  // and, with no handler to hand the dump to, end the process with 0xFFFF7003
  // in place of the fault's own code. The #2398 node-pty access violation read
  // as this in one packaged run and as 0xC0000005 in another.
  [0xffff7001, 'native crash; the Crashpad handler did not respond'],
  [0xffff7002, 'native crash; the Crashpad snapshot failed'],
  [0xffff7003, 'native crash; Crashpad had no handler, the fault code is lost'],
]);

/** `0xC0000005` for any exit code, read as the unsigned 32-bit value Windows reports. */
export function hexExitCode(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** `0xC0000005 (access violation)`; unknown codes carry their decimal value instead. */
export function describeExitCode(code: number): string {
  const unsigned = code >>> 0;
  return `${hexExitCode(unsigned)} (${KNOWN_EXIT_CODES.get(unsigned) ?? `code ${unsigned}`})`;
}

export interface DaemonExitWatch {
  /**
   * The daemon's socket closed (or main gave up on it): find out how the
   * process ended and log it, once. Resolves when the line is written.
   */
  report(reason: string): Promise<void>;
  /** Stop watching. A report already running finishes first. */
  dispose(): void;
}

export interface DaemonExitWatchDeps {
  log: (level: Level, msg: string) => void;
  platform?: NodeJS.Platform;
  /** Windows: open a handle now for reading the exit code later. */
  openHandle?: (pid: number) => ProcessExitHandle | { failure: string };
  /** The exit of a daemon this process spawned; null when it did not spawn `pid`. */
  onChildExit?: (pid: number, cb: (exit: SpawnedDaemonExit) => void, liveOnly: boolean) => (() => void) | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a report waits for the process to exit. */
  budgetMs?: number;
}

/** Waits between reads: quick at first (a crash is over in milliseconds), then 1 s apart. */
const POLL_STEPS_MS = [0, 50, 100, 200, 400];
const POLL_LATER_MS = 1_000;
/** Covers the daemon's 10 s shutdown timeout plus its 1 s forced exit. */
const DEFAULT_BUDGET_MS = 15_000;

/**
 * Start watching daemon `pid` (null when the launcher could not tell it).
 * Call when the daemon is installed, so the handle is open while it lives.
 * `spawned` says this process just spawned it: only then can a launcher
 * child-exit record that has already ended be about this process rather than
 * an earlier one that had the same pid.
 */
export function createDaemonExitWatch(pid: number | null, spawned: boolean, deps: DaemonExitWatchDeps): DaemonExitWatch {
  const platform = deps.platform ?? process.platform;
  const openHandle = deps.openHandle ?? tryOpenProcessExitHandle;
  const onChildExit = deps.onChildExit ?? onSpawnedDaemonExit;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;

  let logged = false;
  let disposed = false;
  // The report in flight, shared by every caller that asks while it runs, so
  // a later caller (a full shutdown waiting before quit) waits for the same
  // evidence instead of returning at once.
  let inFlight: Promise<void> | null = null;
  let childExit: SpawnedDaemonExit | null = null;
  let handle: ProcessExitHandle | null = null;
  let handleFailure: string | null = null;
  let stopChildWatch: (() => void) | null = null;

  const closeHandle = (): void => {
    handle?.close();
    handle = null;
  };
  const release = (): void => {
    stopChildWatch?.();
    stopChildWatch = null;
    closeHandle();
  };

  const logExit = (exit: SpawnedDaemonExit | { code: number; signal: null }, when: string): void => {
    if (logged) return;
    logged = true;
    if (exit.signal) {
      deps.log('warn', `daemon pid ${pid} was killed by ${exit.signal} — ${when}`);
    } else if (exit.code === null) {
      deps.log('warn', `daemon pid ${pid} exited, exit code unavailable: the child reported none — ${when}`);
    } else {
      deps.log(exit.code === 0 ? 'info' : 'warn', `daemon pid ${pid} exited ${describeExitCode(exit.code)} — ${when}`);
    }
  };

  if (pid === null) {
    handleFailure = 'the launcher did not report the daemon pid';
  } else {
    // The child 'exit' event arrives without any socket close to wait for:
    // log it as soon as it comes. A daemon found running may still be one
    // this process spawned earlier (a reconnect); then only a record of a
    // child still running is about it.
    stopChildWatch = onChildExit(pid, (exit) => {
      childExit = exit;
      logExit(exit, 'child exit');
      if (!inFlight) release();
    }, !spawned);
    if (platform === 'win32' && !logged) {
      const opened = openHandle(pid);
      if ('failure' in opened) handleFailure = opened.failure;
      else handle = opened;
    } else if (stopChildWatch === null) {
      handleFailure = platform === 'win32'
        ? 'no process handle'
        : 'this process did not spawn the daemon, so it gets no exit event';
    }
  }

  /** One look at how the process stands. */
  const readOnce = (): { exited: SpawnedDaemonExit | { code: number; signal: null } } | { running: true } | { unavailable: string } => {
    if (childExit) return { exited: childExit };
    if (handle) {
      const r = handle.read();
      if (r.state === 'exited') return { exited: { code: r.code, signal: null } };
      if (r.state === 'running') return { running: true };
      // A child exit event can still bring the code; keep waiting for it.
      if (stopChildWatch) return { running: true };
      return { unavailable: r.failure };
    }
    // A spawned child with no handle (POSIX): alive until its exit event.
    if (stopChildWatch) return { running: true };
    return { unavailable: handleFailure ?? 'no way to read it' };
  };

  return {
    report(reason: string): Promise<void> {
      if (inFlight) return inFlight;
      if (logged || disposed) return Promise.resolve();
      // The await always yields, so the cleanup below runs after inFlight is
      // set, even when poll() finishes without waiting.
      inFlight = (async () => {
        try {
          await poll(reason);
        } finally {
          inFlight = null;
          if (logged || disposed) release();
        }
      })();
      return inFlight;
    },
    dispose(): void {
      disposed = true;
      if (!inFlight) release();
    },
  };

  async function poll(reason: string): Promise<void> {
    const startedAt = now();
    for (let step = 0; ; step++) {
      const wait = POLL_STEPS_MS[step] ?? POLL_LATER_MS;
      if (wait > 0) await sleep(wait);
      if (logged) return;
      const r = readOnce();
      if ('exited' in r) {
        logExit(r.exited, `at ${reason}`);
        return;
      }
      if ('unavailable' in r) {
        logged = true;
        deps.log('warn', `daemon pid ${pid ?? '?'} ${reason}, exit code unavailable: ${r.unavailable}`);
        return;
      }
      if (now() - startedAt >= budgetMs) {
        logged = true;
        deps.log('warn', `daemon pid ${pid} still running ${now() - startedAt}ms after ${reason} — exit code unavailable: it has not exited`);
        return;
      }
    }
  }
}
