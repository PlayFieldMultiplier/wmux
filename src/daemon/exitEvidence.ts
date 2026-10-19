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
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';

/** The slice of `process` this module touches, so tests can hand in a fake. */
export interface ExitEvidenceProcess {
  pid: number;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'uncaughtExceptionMonitor', listener: (err: unknown, origin: string) => void): unknown;
  listenerCount(event: string): number;
  report?: { reportOnFatalError: boolean; directory: string; excludeEnv?: boolean; excludeNetwork?: boolean } | undefined;
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

/** Node's report file name: `report.<YYYYMMDD>.<HHMMSS>.<pid>.<tid>.<seq>.json`. */
const REPORT_FILE = /^report\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.json$/;
const REPORTS_KEPT = 10;
const REPORT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

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
      // A report still carries the daemon's command line (argv) and working
      // directory.
      const canExcludeEnv = 'excludeEnv' in proc.report;
      if (canExcludeEnv) proc.report.excludeEnv = true;
      if (!canExcludeEnv || proc.report.excludeEnv !== true) {
        opts.log('warn', '[exit] diagnostic reports off: this Node cannot leave the environment out of them');
        return;
      }
      // The header also lists every network interface with its MAC and IP
      // addresses, and each TCP endpoint gets a reverse DNS lookup (which,
      // in a process that is dying, is also a wait). None of it names a
      // crash cause. Best effort: an older Node keeps it.
      if ('excludeNetwork' in proc.report) proc.report.excludeNetwork = true;
      fs.mkdirSync(opts.reportDir, { recursive: true });
      // In the background: startup must not wait on the disk.
      void pruneCrashReports(opts.reportDir, { log: opts.log, now });
      proc.report.directory = opts.reportDir;
      proc.report.reportOnFatalError = true;
      opts.log('info', `[exit] a fatal error writes a diagnostic report (environment excluded) to ${opts.reportDir}`);
    } catch (err) {
      opts.log('warn', `[exit] diagnostic reports unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

/**
 * Keep the report directory bounded. A fault that recurs on every start (an
 * out-of-memory the session data reproduces, under a service manager that
 * restarts the daemon every 2 s) would otherwise fill the disk that session
 * saves need. Removes the reports beyond the newest REPORTS_KEPT, and any
 * older than REPORT_MAX_AGE_MS. Only files named like Node's reports are
 * touched, each checked with lstat: a link or a directory under that name is
 * left alone, and so is a report directory that is itself a link.
 *
 * Never throws: a failure is one warn line and the daemon carries on.
 */
export async function pruneCrashReports(
  dir: string,
  opts: { log: (level: Level, msg: string) => void; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  let failed = 0;
  let firstError = '';
  const fail = (err: unknown): void => {
    if (failed++ === 0) firstError = err instanceof Error ? err.message : String(err);
  };
  let removed = 0;
  try {
    if (!(await fs.promises.lstat(dir)).isDirectory()) {
      opts.log('warn', `[exit] old diagnostic reports not pruned: ${dir} is not a plain directory`);
      return;
    }
    const reports: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of await fs.promises.readdir(dir)) {
      if (!REPORT_FILE.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.lstat(file);
        if (st.isFile()) reports.push({ file, mtimeMs: st.mtimeMs });
      } catch (err) {
        fail(err);
      }
    }
    reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = now() - REPORT_MAX_AGE_MS;
    for (const [i, r] of reports.entries()) {
      if (i < REPORTS_KEPT && r.mtimeMs >= cutoff) continue;
      try {
        await fs.promises.unlink(r.file);
        removed++;
      } catch (err) {
        fail(err);
      }
    }
  } catch (err) {
    fail(err);
  }
  try {
    if (removed > 0) opts.log('info', `[exit] removed ${removed} old diagnostic report(s) from ${dir}`);
    if (failed > 0) opts.log('warn', `[exit] pruning old diagnostic reports in ${dir} hit ${failed} error(s), first: ${firstError}`);
  } catch {
    // Evidence must never be what breaks the daemon.
  }
}
