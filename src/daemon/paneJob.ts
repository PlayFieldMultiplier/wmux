/**
 * #2398 — the pane shells a daemon started die with it.
 *
 * Nothing tied a pane's process tree to the daemon's lifetime, so a daemon that
 * crashed or was force-killed left every pane shell running (and the wsl.exe
 * of every WSL pane). Each crash made the next start worse: the next daemon
 * spawns a fresh set while the orphans keep their memory.
 *
 * One Job Object per daemon, created on the first pane, with
 * KILL_ON_JOB_CLOSE | BREAKAWAY_OK. The daemon holds its only handle (not
 * inheritable, never duplicated), so when the daemon dies for any reason the
 * job closes and Windows ends every process in it. Only the shells of panes
 * the daemon spawned through node-pty are assigned; their children inherit the
 * job. Never the daemon itself, and never a process wmux did not start.
 *
 * A clean exit (quit, update, B′ replacement) disarms the job the moment it
 * decides to exit, before any shutdown phase that a caller's kill budget could
 * cut short: it clears KILL_ON_JOB_CLOSE, so programs started from a pane on
 * purpose (`start`, a background server) survive it as they always have.
 * Owner decision on #2398 (§6-11): they die only when the daemon crashes or is
 * force-killed.
 *
 * Which process a pid names is checked before it is assigned. node-pty closes
 * its handle on the shell as soon as the shell exits, so a shell that exits at
 * once can free its pid before the session registers, and the pid can then
 * name another process. The job opens the pid and, while that handle pins it,
 * requires the process to be the daemon's own child created no earlier than
 * the spawn began. Observed on Windows 11 with node-pty 1.2.0-beta.15, for the
 * in-box ConPTY and the bundled conpty.dll alike: the shell's parent is the
 * daemon (CreateProcess runs in the daemon), and conhost.exe/OpenConsole.exe is
 * its sibling, not its parent. The creation time rules out a process that
 * still names our pid as its parent from before this daemon owned that pid
 * (Windows never re-parents an orphan).
 *
 * Limits of what it guarantees:
 * - OpenConsole/conhost are started by CreatePseudoConsole before the shell
 *   exists, so they stay outside; they exit when the daemon's pseudoconsole
 *   handles close.
 * - A WSL pane's wsl.exe is contained, but not wslhost.exe: that one is a
 *   child of wslservice.exe, not of the pane. The Linux side ends when the
 *   wsl.exe relay closes.
 * - node-pty does not create the shell suspended: anything the shell starts in
 *   the moment between CreateProcess and the assignment escapes.
 * - BREAKAWAY_OK lets a program that asks for CREATE_BREAKAWAY_FROM_JOB leave;
 *   without it such a program would fail to start at all.
 * - A shell that cannot be opened, identified or assigned (an elevated process,
 *   one already in a job that refuses nesting) stays uncontained, as before;
 *   the create never fails over it. A native call that throws turns the job
 *   off for the daemon's life instead of failing the create.
 * The Rust backend puts each pane in its own kill-on-close job already
 * (psuedocon.rs), and those cannot be mixed into this one, so its panes are
 * skipped by the caller.
 */

import { tryProcessCreatedAt, tryProcessHandleApi } from '../main/pty/winSnapshotNative';

export interface JobNative {
  /** A new unnamed job, or null (with the error code) when it cannot be made. */
  createJob(): { job: bigint } | { error: number };
  /** Set KILL_ON_JOB_CLOSE (always with BREAKAWAY_OK). 0 on success, else the error code. */
  setKillOnClose(job: bigint, kill: boolean): number;
  /**
   * Open a process to assign it. While the handle is open the pid cannot be
   * handed to another process, so whatever is read about the pid names this one.
   */
  open(pid: number): { handle: bigint } | { error: number };
  /** Assign an opened process. 0 on success, else the error code. */
  assign(job: bigint, handle: bigint): number;
  close(handle: bigint): void;
}

/** Who a pid is, read while the job holds a handle on it. */
export interface ShellIdentity {
  /** The system clock creation times are stamped in (FILETIME, 100 ns units). */
  now(): bigint;
  /** The parent pid and creation time of a live process, or null when either cannot be read. */
  read(pid: number): { ppid: number; createdAt: bigint } | null;
}

export interface PaneJob {
  /**
   * Read right before a pane shell is spawned and handed to contain(): the
   * shell must be created no earlier. Null where there is no job. Never throws.
   */
  spawnMark(): bigint | null;
  /** Put a pane shell the daemon just spawned in the job. Never throws. */
  contain(pid: number, spawnMark: bigint | null): void;
  /** Before a clean exit: closing the job no longer ends what is in it. Never throws. */
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
    open(pid) {
      const handle = BigInt(k.OpenProcess(ASSIGN_ACCESS, 0, pid));
      return handle === 0n ? { error: k.GetLastError() || -1 } : { handle };
    },
    assign: (job, handle) => (k.AssignProcessToJobObject(job, handle) ? 0 : k.GetLastError() || -1),
    close(handle) {
      k.CloseHandle(handle);
    },
  };
}

/** Parent and creation time through winSnapshotNative, or null off Windows / without koffi. */
export function loadShellIdentity(): ShellIdentity | null {
  const api = tryProcessHandleApi();
  if (!api) return null;
  return {
    // GetSystemTimeAsFileTime: the same coarse clock process creation times
    // are stamped in, so a shell created after a mark never reads as earlier.
    now: () => api.now(),
    read(pid) {
      const createdAt = tryProcessCreatedAt(pid);
      if (createdAt === null) return null;
      let table;
      try {
        table = api.processTable();
      } catch {
        return null;
      }
      const row = table.find((p) => p.pid === pid);
      return row ? { ppid: row.ppid, createdAt } : null;
    },
  };
}

export function createPaneJob(opts: {
  log: (level: 'info' | 'warn', message: string) => void;
  /** Tests inject a fake; null disables the job (non-Windows, koffi missing). */
  native?: () => JobNative | null;
  /** Tests inject a fake; null disables the job. */
  identity?: () => ShellIdentity | null;
  /** The pid a pane shell's parent must be. Defaults to this process. */
  daemonPid?: number;
}): PaneJob {
  const loadNative = opts.native ?? (() => loadJobNative((m) => opts.log('warn', `[pane-job] ${m}`)));
  const loadIdentity = opts.identity ?? loadShellIdentity;
  const daemonPid = opts.daemonPid ?? process.pid;
  let native: JobNative | null | undefined;
  let identity: ShellIdentity | null | undefined;
  let job: bigint | null = null;
  let disabled = false;
  let armed = true;
  let contained = 0;
  let failed = 0;
  // One line per distinct refusal, so a machine that refuses every pane logs once.
  const reported = new Set<string>();

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const identityOrNull = (): ShellIdentity | null => {
    if (identity === undefined) identity = loadIdentity();
    return identity;
  };

  const ensureJob = (): bigint | null => {
    if (job !== null || disabled) return job;
    native = loadNative();
    if (!native || !identityOrNull()) {
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

  /** A shell left outside the job, logged once per kind of reason. */
  const refuse = (pid: number, kind: string, why: string): void => {
    failed++;
    if (reported.has(kind)) return;
    reported.add(kind);
    opts.log('warn', `[pane-job] pid ${pid} not contained (${why}); it outlives a crashed daemon`);
  };

  /** A native call threw: the job is off for this daemon's life, and the create goes on. */
  const fail = (what: string, err: unknown): void => {
    disabled = true;
    if (reported.has('throw')) return;
    reported.add('throw');
    opts.log('warn', `[pane-job] ${what} threw (${errorText(err)}); pane shells are no longer tied to the daemon`);
  };

  return {
    spawnMark() {
      if (disabled) return null;
      try {
        return identityOrNull()?.now() ?? null;
      } catch (err) {
        fail('reading the clock', err);
        return null;
      }
    },
    contain(pid, spawnMark) {
      if (!armed || disabled || !Number.isInteger(pid) || pid <= 0) return;
      try {
        const j = ensureJob();
        if (j === null || !native || !identity) return;
        if (spawnMark === null) {
          refuse(pid, 'mark', 'its spawn time is unknown');
          return;
        }
        const opened = native.open(pid);
        if ('error' in opened) {
          refuse(pid, `error:${opened.error}`, `error ${opened.error}`);
          return;
        }
        try {
          // The open handle pins the pid, so this reads the process assign takes.
          const who = identity.read(pid);
          if (!who) refuse(pid, 'unread', 'its parent and creation time cannot be read');
          else if (who.ppid !== daemonPid) refuse(pid, 'parent', `its parent is pid ${who.ppid}, not the daemon`);
          else if (who.createdAt < spawnMark) refuse(pid, 'created', 'it was created before the spawn');
          else {
            const error = native.assign(j, opened.handle);
            if (error === 0) contained++;
            else refuse(pid, `error:${error}`, `error ${error}`);
          }
        } finally {
          native.close(opened.handle);
        }
      } catch (err) {
        failed++;
        fail(`containing pid ${pid}`, err);
      }
    },
    disarm() {
      armed = false;
      if (job === null || !native) return;
      try {
        const error = native.setKillOnClose(job, false);
        if (error) opts.log('warn', `[pane-job] could not disarm the job (error ${error}); programs started from panes end with the daemon`);
        else opts.log('info', '[pane-job] disarmed for a clean exit');
      } catch (err) {
        opts.log('warn', `[pane-job] disarming threw (${errorText(err)}); programs started from panes end with the daemon`);
      }
    },
    stats: () => ({ contained, failed }),
  };
}
