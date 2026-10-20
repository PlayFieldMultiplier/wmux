/**
 * #2398 — the pane shells a daemon started die with it.
 *
 * Nothing tied a pane's process tree to the daemon's lifetime, so a daemon that
 * crashed or was force-killed left every pane shell running (and every
 * wsl.exe/wslhost.exe under them). Each crash made the next start worse: the
 * next daemon spawns a fresh set while the orphans keep their memory.
 *
 * One Job Object per daemon, created on the first pane, with
 * KILL_ON_JOB_CLOSE | BREAKAWAY_OK. The daemon holds its only handle (not
 * inheritable, never duplicated), so when the daemon dies for any reason the
 * job closes and Windows ends every process in it. Only the shells of panes
 * the daemon spawned through node-pty are assigned; their children inherit the
 * job. Never the daemon itself, and never a process wmux did not start.
 *
 * A clean exit (quit, update, B′ replacement) disarms the job first: it clears
 * KILL_ON_JOB_CLOSE after the panes were disposed, so programs started from a
 * pane on purpose (`start`, a background server) survive it as they always
 * have. Owner decision on #2398 (§6-11): they die only when the daemon crashes
 * or is force-killed.
 *
 * Limits of what it guarantees:
 * - OpenConsole/conhost are started by CreatePseudoConsole before the shell
 *   exists, so they stay outside; they exit when the daemon's pseudoconsole
 *   handles close.
 * - node-pty does not create the shell suspended: anything the shell starts in
 *   the moment between CreateProcess and the assignment escapes.
 * - BREAKAWAY_OK lets a program that asks for CREATE_BREAKAWAY_FROM_JOB leave;
 *   without it such a program would fail to start at all.
 * - A shell that cannot be opened or assigned (an elevated process, or one
 *   already in a job that refuses nesting) stays uncontained, as before; the
 *   create never fails over it.
 * The Rust backend puts each pane in its own kill-on-close job already
 * (psuedocon.rs), and those cannot be mixed into this one, so its panes are
 * skipped by the caller.
 */

export interface JobNative {
  /** A new unnamed job, or null (with the error code) when it cannot be made. */
  createJob(): { job: bigint } | { error: number };
  /** Set KILL_ON_JOB_CLOSE (always with BREAKAWAY_OK). 0 on success, else the error code. */
  setKillOnClose(job: bigint, kill: boolean): number;
  /** Assign a process by pid. 0 on success, else the error code. */
  assign(job: bigint, pid: number): number;
}

export interface PaneJob {
  /** Put a pane shell the daemon just spawned in the job. Never throws. */
  contain(pid: number): void;
  /** Before a clean exit: closing the job no longer ends what is in it. */
  disarm(): void;
  /** Ping diagnostics: shells contained, and shells the job could not take. */
  stats(): { contained: number; failed: number };
}

const KILL_ON_JOB_CLOSE = 0x2000;
const BREAKAWAY_OK = 0x800;
/** JobObjectExtendedLimitInformation. */
const EXTENDED_LIMIT_INFORMATION = 9;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows. */
export const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** Offset of BasicLimitInformation.LimitFlags in that struct. */
const LIMIT_FLAGS_OFFSET = 16;
/** PROCESS_SET_QUOTA | PROCESS_TERMINATE, what AssignProcessToJobObject needs. */
const ASSIGN_ACCESS = 0x0100 | 0x0001;

/** The limit block SetInformationJobObject takes, with only LimitFlags set. */
export function extendedLimitInformation(kill: boolean): Buffer {
  const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
  info.writeUInt32LE(kill ? KILL_ON_JOB_CLOSE | BREAKAWAY_OK : BREAKAWAY_OK, LIMIT_FLAGS_OFFSET);
  return info;
}

interface Kernel32 {
  CreateJobObjectW(attributes: null, name: null): bigint;
  SetInformationJobObject(job: bigint, infoClass: number, info: Buffer, length: number): number;
  OpenProcess(access: number, inherit: number, pid: number): bigint;
  AssignProcessToJobObject(job: bigint, process: bigint): number;
  CloseHandle(handle: bigint): number;
  GetLastError(): number;
}

/** The kernel32 calls through koffi, or null where they cannot be loaded. */
export function loadJobNative(warn: (message: string) => void): JobNative | null {
  if (process.platform !== 'win32') return null;
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null;
  let k: Kernel32;
  try {
    // Runtime require, external to the bundle like node-pty (winSnapshotNative.ts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as { load(name: string): { func(name: string, result: string, args: string[]): unknown } };
    const kernel32 = koffi.load('kernel32.dll');
    k = {
      CreateJobObjectW: kernel32.func('CreateJobObjectW', 'int64', ['void *', 'void *']) as Kernel32['CreateJobObjectW'],
      SetInformationJobObject: kernel32.func('SetInformationJobObject', 'int', ['int64', 'int', 'void *', 'uint32']) as Kernel32['SetInformationJobObject'],
      OpenProcess: kernel32.func('OpenProcess', 'int64', ['uint32', 'int', 'uint32']) as Kernel32['OpenProcess'],
      AssignProcessToJobObject: kernel32.func('AssignProcessToJobObject', 'int', ['int64', 'int64']) as Kernel32['AssignProcessToJobObject'],
      CloseHandle: kernel32.func('CloseHandle', 'int', ['int64']) as Kernel32['CloseHandle'],
      GetLastError: kernel32.func('GetLastError', 'uint32', []) as Kernel32['GetLastError'],
    };
  } catch (err) {
    warn(`koffi load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const setLimits = (job: bigint, kill: boolean): number => {
    const info = extendedLimitInformation(kill);
    return k.SetInformationJobObject(job, EXTENDED_LIMIT_INFORMATION, info, info.length) ? 0 : k.GetLastError() || -1;
  };
  return {
    createJob() {
      const job = BigInt(k.CreateJobObjectW(null, null));
      if (job === 0n) return { error: k.GetLastError() || -1 };
      const error = setLimits(job, true);
      if (error) {
        k.CloseHandle(job);
        return { error };
      }
      return { job };
    },
    setKillOnClose: setLimits,
    assign(job, pid) {
      const handle = BigInt(k.OpenProcess(ASSIGN_ACCESS, 0, pid));
      if (handle === 0n) return k.GetLastError() || -1;
      try {
        return k.AssignProcessToJobObject(job, handle) ? 0 : k.GetLastError() || -1;
      } finally {
        k.CloseHandle(handle);
      }
    },
  };
}

export function createPaneJob(opts: {
  log: (level: 'info' | 'warn', message: string) => void;
  /** Tests inject a fake; null disables the job (non-Windows, koffi missing). */
  native?: () => JobNative | null;
}): PaneJob {
  const loadNative = opts.native ?? (() => loadJobNative((m) => opts.log('warn', `[pane-job] ${m}`)));
  let native: JobNative | null | undefined;
  let job: bigint | null = null;
  let disabled = false;
  let armed = true;
  let contained = 0;
  let failed = 0;
  // One line per distinct refusal, so a machine that refuses every pane logs once.
  const reported = new Set<number>();

  const ensureJob = (): bigint | null => {
    if (job !== null || disabled) return job;
    native = loadNative();
    if (!native) {
      disabled = true;
      return null;
    }
    const made = native.createJob();
    if ('error' in made) {
      disabled = true;
      opts.log('warn', `[pane-job] could not create the job (error ${made.error}); pane shells are not tied to the daemon`);
      return null;
    }
    job = made.job;
    opts.log('info', '[pane-job] pane shells end with the daemon (kill-on-close job)');
    return job;
  };

  return {
    contain(pid) {
      if (!armed || !Number.isInteger(pid) || pid <= 0) return;
      const j = ensureJob();
      if (j === null || !native) return;
      const error = native.assign(j, pid);
      if (error === 0) {
        contained++;
        return;
      }
      failed++;
      if (!reported.has(error)) {
        reported.add(error);
        opts.log('warn', `[pane-job] pid ${pid} not contained (error ${error}); it outlives a crashed daemon`);
      }
    },
    disarm() {
      armed = false;
      if (job === null || !native) return;
      const error = native.setKillOnClose(job, false);
      if (error) opts.log('warn', `[pane-job] could not disarm the job (error ${error}); programs started from panes end with the daemon`);
      else opts.log('info', '[pane-job] disarmed for a clean exit');
    },
    stats: () => ({ contained, failed }),
  };
}
