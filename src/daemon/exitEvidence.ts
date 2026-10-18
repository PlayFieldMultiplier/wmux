/**
 * Why the daemon exited, written down before it goes.
 *
 * A daemon that died during a live test (#2398) left no log line, no exit line
 * and no WER report, and it took hours to find that node-pty had faulted
 * natively. These hooks make every exit JS can still see leave one line in the
 * daemon log: the exit code, the reasons noted on the way out, and the JS frames
 * that called `process.exit()`. A native fault never reaches JS; main logs the
 * daemon's exit code for that case (src/main/daemon/daemonExitWatch.ts).
 *
 * Evidence only. Nothing here may change whether the daemon exits:
 *  - Uncaught exceptions are watched through `uncaughtExceptionMonitor`, which
 *    Node calls without counting it as a handler. Before the daemon's own
 *    `uncaughtException` handler is installed, an exception is still fatal;
 *    afterwards that handler still decides (and logs) as it always did.
 *  - Signal listeners change behaviour by existing (Node stops terminating on
 *    the signal), so this module registers none; the daemon notes the signal
 *    in the handlers it already has.
 *
 * Every line goes through the daemon's `log()` at warn/error, which its writer
 * appends synchronously — an `info` line from an 'exit' listener would sit in
 * a buffer that nothing flushes again.
 */

import fs from 'node:fs';

type Level = 'info' | 'warn' | 'error';

/** The slice of `process` this module touches, so tests can hand in a fake. */
export interface ExitEvidenceProcess {
  pid: number;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'uncaughtExceptionMonitor', listener: (err: unknown, origin: string) => void): unknown;
  listenerCount(event: string): number;
  report?: { reportOnFatalError: boolean; directory: string; excludeEnv?: boolean } | undefined;
}

export interface ExitEvidenceOptions {
  log: (level: Level, msg: string) => void;
  /** Errors the daemon already drops on purpose (a broken stdio pipe before its log sink owns stdio). */
  ignoreError?: (err: unknown) => boolean;
  /** Where Node writes a diagnostic report on a fatal error; omitted = none. */
  reportDir?: string;
  now?: () => number;
}

/** What Windows ends a process with on Ctrl+C / Ctrl+Break when nothing handles it. */
export const STATUS_CONTROL_C_EXIT = 0xc000013a;

/** Reasons beyond this many keep only the latest (a storm must not grow one line without bound). */
const MAX_REASONS = 6;
const STACK_FRAMES = 25;

let reasons: string[] = [];

/**
 * Record why the daemon is on its way out, for the exit line. Called at each
 * place the daemon decides to exit (a signal, a shutdown, a startup failure).
 */
export function noteExitReason(reason: string): void {
  reasons.push(reason);
  if (reasons.length > MAX_REASONS) reasons = reasons.slice(-MAX_REASONS);
}

/** Test seam: forget noted reasons. */
export function resetExitReasonsForTest(): void {
  reasons = [];
}

/**
 * Collapse a stack to one line of caller frames. Frames inside Node itself
 * (`node:` URLs) and the first `skip` frames (the listener's own) are dropped,
 * so what remains is the code that asked to exit.
 */
export function oneLineFrames(stack: string | undefined, skip = 0): string {
  if (!stack) return '';
  return stack
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .slice(skip)
    .map((l) => l.trim().replace(/^at /, ''))
    .filter((l) => !/\(node:|^node:/.test(l))
    .join(' < ');
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const frames = oneLineFrames(err.stack);
    return `${err.name}: ${err.message}${code ? ` code=${code}` : ''}${frames ? ` at ${frames}` : ''}`;
  }
  try { return `non-error value: ${String(err)}`; } catch { return 'non-error value'; }
}

/**
 * Install the hooks. Call once, as early as `log()` works: the exit listener
 * then runs ahead of the listeners that save state on exit, so the line is
 * written even if one of those hangs or throws.
 */
export function installExitEvidence(proc: ExitEvidenceProcess, opts: ExitEvidenceOptions): void {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  proc.on('exit', (code) => {
    try {
      // process.exit() emits 'exit' synchronously, so the frames under this
      // listener are its caller's. A loop that drained has none of ours.
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = STACK_FRAMES;
      const stack = new Error().stack;
      Error.stackTraceLimit = limit;
      const caller = oneLineFrames(stack, 1);
      opts.log(
        'warn',
        `[exit] daemon pid=${proc.pid} exiting code=${code} ` +
          `reason=${reasons.length ? reasons.join(' > ') : 'none noted'} ` +
          `uptime=${Math.round((now() - startedAt) / 1000)}s ` +
          `caller=${caller || 'none (the event loop drained, or the exit came from native code)'}`,
      );
    } catch {
      // Evidence must never be what breaks the exit.
    }
  });

  proc.on('uncaughtExceptionMonitor', (err, origin) => {
    try {
      if (opts.ignoreError?.(err)) return;
      // With a handler installed, the exception is the handler's to judge and
      // log; the monitor only speaks for the ones that end the process.
      if (proc.listenerCount('uncaughtException') > 0) return;
      noteExitReason(`fatal ${origin}`);
      opts.log('error', `[exit] fatal ${origin} with no handler — the process exits: ${describeError(err)}`);
    } catch {
      // As above.
    }
  });

  // Fatal errors Node can still report on (V8 out of memory, a failed
  // internal assertion) skip every JS listener; a report file is all they
  // leave. A native access violation leaves not even that.
  if (opts.reportDir && proc.report) {
    try {
      // A report carries the environment by default, and the daemon's holds
      // whatever credentials it inherited (API keys, tokens). Leave it out;
      // a Node that cannot do that writes no reports at all. The setting has
      // to exist before it is set: on a Node without it, the assignment only
      // adds a plain property that reads back true and changes nothing.
      const canExcludeEnv = 'excludeEnv' in proc.report;
      if (canExcludeEnv) proc.report.excludeEnv = true;
      if (!canExcludeEnv || proc.report.excludeEnv !== true) {
        opts.log('warn', '[exit] diagnostic reports off: this Node cannot leave the environment out of them');
        return;
      }
      fs.mkdirSync(opts.reportDir, { recursive: true });
      proc.report.directory = opts.reportDir;
      proc.report.reportOnFatalError = true;
      opts.log('info', `[exit] a fatal error writes a diagnostic report (environment excluded) to ${opts.reportDir}`);
    } catch (err) {
      opts.log('warn', `[exit] diagnostic reports unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
