// #2398 — the daemon's kill-on-close job for pane shells (paneJob.ts), against
// a fake kernel32: one job made lazily on the first pane, every pane's shell
// assigned once it is proven, through the handle that assigns it, to be the
// daemon's own fresh child, refusals logged once and never thrown, a clean
// exit disarming it. The real job on Windows: paneJob.os.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPaneJob,
  extendedLimitInformation,
  EXTENDED_LIMIT_INFORMATION_SIZE,
  PARENT_PID_OFFSET,
  PROCESS_BASIC_INFORMATION_SIZE,
  type JobNative,
} from '../paneJob';

const DAEMON = 4000;
const MARK = 1_000n;

type Who = { ppid: number; createdAt: bigint } | { error: string };

/** The fake's handle for a pid: never equal to the pid, so a pid passed where a handle belongs shows. */
const handleOf = (pid: number): bigint => BigInt(pid) * 10n;

/**
 * Every opened process reads as the daemon's child created after MARK, unless
 * `who` says otherwise for its pid.
 */
function fakeNative(overrides: Partial<JobNative> = {}, who: Record<number, Who> = {}) {
  const calls: string[] = [];
  const closed: bigint[] = [];
  const native: JobNative = {
    createJob: vi.fn(() => { calls.push('create'); return { job: 7n }; }),
    setKillOnClose: vi.fn((job: bigint, kill: boolean) => { calls.push(`kill:${job}:${kill}`); return 0; }),
    open: vi.fn((pid: number) => ({ handle: handleOf(pid) })),
    identify: vi.fn((handle: bigint) => {
      const pid = Number(handle / 10n);
      return pid in who ? who[pid] : { ppid: DAEMON, createdAt: MARK + 1n };
    }),
    assign: vi.fn((job: bigint, handle: bigint) => { calls.push(`assign:${job}:${handle}`); return 0; }),
    close: vi.fn((handle: bigint) => { closed.push(handle); }),
    now: vi.fn(() => MARK),
    ...overrides,
  };
  return { native, calls, closed };
}

const newLog = () => vi.fn<(level: 'info' | 'warn', message: string) => void>();
type Log = ReturnType<typeof newLog>;

function paneJob(native: JobNative | null, opts: { log?: Log } = {}) {
  return createPaneJob({ log: opts.log ?? newLog(), native: () => native, daemonPid: DAEMON });
}

const warnings = (log: Log) => log.mock.calls.filter(([level]) => level === 'warn');

describe('createPaneJob', () => {
  it('makes one job on the first pane and assigns every pane shell to it', () => {
    const { native, calls, closed } = fakeNative();
    const job = paneJob(native);
    expect(calls).toEqual([]);
    expect(job.spawnMark()).toBe(MARK);
    job.contain(101, MARK);
    job.contain(102, MARK);
    expect(calls).toEqual(['create', 'assign:7:1010', 'assign:7:1020']);
    expect(closed).toEqual([1010n, 1020n]);
    expect(job.stats()).toEqual({ contained: 2, failed: 0 });
  });

  it('identifies the shell through the handle it assigns, never by pid again', () => {
    // A pid looked up a second time can name another process by then, and a
    // machine-wide process snapshot per pane blocked the daemon for ~20 ms
    // each through a cold-start burst. Only open() may see the pid.
    const { native } = fakeNative();
    const job = paneJob(native);
    job.contain(101, MARK);
    expect(native.open).toHaveBeenCalledWith(101);
    expect(native.identify).toHaveBeenCalledExactlyOnceWith(1010n);
    expect(native.assign).toHaveBeenCalledWith(7n, 1010n);
    expect(native.close).toHaveBeenCalledWith(1010n);
  });

  it('leaves a shell it cannot take running, logging each kind of refusal once', () => {
    const log = newLog();
    const { native, closed } = fakeNative({ assign: vi.fn(() => 5) });
    const job = paneJob(native, { log });
    expect(() => { job.contain(101, MARK); job.contain(102, MARK); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(closed).toEqual([1010n, 1020n]);
    expect(warnings(log)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('error 5'));
  });

  it('never assigns a pid whose process the daemon did not spawn (a pid reused after the shell exited)', () => {
    const log = newLog();
    const { native, closed } = fakeNative({}, {
      101: { ppid: 9999, createdAt: MARK + 1n },
      102: { ppid: 9999, createdAt: MARK + 2n },
    });
    const job = paneJob(native, { log });
    job.contain(101, MARK);
    job.contain(102, MARK);
    expect(native.assign).not.toHaveBeenCalled();
    // The process stayed pinned through the check and was let go after it.
    expect(closed).toEqual([1010n, 1020n]);
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(warnings(log)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('parent is pid 9999'));
  });

  it('never assigns a process created before the spawn, though it names the daemon as parent', () => {
    // Windows never re-parents an orphan: a process whose parent died before
    // this daemon got that pid still names it.
    const { native } = fakeNative({}, { 101: { ppid: DAEMON, createdAt: MARK - 1n } });
    const job = paneJob(native);
    job.contain(101, MARK);
    expect(native.assign).not.toHaveBeenCalled();
    expect(job.stats()).toEqual({ contained: 0, failed: 1 });
  });

  it('never assigns a process it cannot identify, or one with no spawn mark', () => {
    const log = newLog();
    const { native } = fakeNative({}, { 101: { error: 'NtQueryInformationProcess status 0xc0000022' } });
    const job = paneJob(native, { log });
    job.contain(101, MARK);
    job.contain(102, null);
    expect(native.assign).not.toHaveBeenCalled();
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('status 0xc0000022'));
  });

  it('stays off when the job cannot be made, without trying again per pane', () => {
    const log = newLog();
    const createJob = vi.fn(() => ({ error: 8 }));
    const { native } = fakeNative({ createJob });
    const job = paneJob(native, { log });
    job.contain(101, MARK);
    job.contain(102, MARK);
    expect(createJob).toHaveBeenCalledOnce();
    expect(native.open).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('error 8'));
  });

  it('does nothing where there is no native job (macOS, Linux, koffi missing)', () => {
    const job = paneJob(null);
    expect(job.spawnMark()).toBeNull();
    expect(() => { job.contain(101, null); job.disarm(); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 0 });
  });

  it('ignores a pid that is not a real one', () => {
    const { native } = fakeNative();
    const job = paneJob(native);
    job.contain(0, MARK);
    job.contain(-1, MARK);
    job.contain(Number.NaN, MARK);
    expect(native.createJob).not.toHaveBeenCalled();
  });

  const boom = () => { throw new Error('boom'); };
  it.each([
    ['createJob', { createJob: vi.fn(boom) }, 0],
    ['open', { open: vi.fn(boom) }, 1],
    ['identify', { identify: vi.fn(boom) }, 1],
    ['assign', { assign: vi.fn(boom) }, 1],
    ['close', { close: vi.fn(boom) }, 1],
  ] as Array<[string, Partial<JobNative>, number]>)(
    'a %s that throws turns the job off for good instead of failing the create',
    (_name, override, opens) => {
      const log = newLog();
      const { native } = fakeNative(override);
      const job = paneJob(native, { log });
      expect(() => job.contain(101, MARK)).not.toThrow();
      expect(() => job.contain(102, MARK)).not.toThrow();
      expect(job.spawnMark()).toBeNull();
      expect(native.open).toHaveBeenCalledTimes(opens);
      expect(job.stats().failed).toBe(1);
      expect(warnings(log)).toHaveLength(1);
      expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('threw (boom)'));
    },
  );

  it('a clock that throws gives no mark and turns the job off', () => {
    const log = newLog();
    const { native } = fakeNative({ now: vi.fn(boom) });
    const job = paneJob(native, { log });
    expect(job.spawnMark()).toBeNull();
    expect(() => job.contain(101, MARK)).not.toThrow();
    expect(native.open).not.toHaveBeenCalled();
    expect(warnings(log)).toHaveLength(1);
  });

  it('a disarm that throws is logged, not thrown', () => {
    const log = newLog();
    const { native } = fakeNative({ setKillOnClose: boom });
    const job = paneJob(native, { log });
    job.contain(101, MARK);
    expect(() => job.disarm()).not.toThrow();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('disarming threw (boom)'));
  });


  it('disarms on a clean exit: kill-on-close is cleared, and no later shell joins', () => {
    const { native, calls } = fakeNative();
    const job = paneJob(native);
    job.contain(101, MARK);
    job.disarm();
    job.contain(102, MARK);
    expect(calls).toEqual(['create', 'assign:7:1010', 'kill:7:false']);
  });

  it('disarming before any pane started has nothing to do', () => {
    const { native } = fakeNative();
    const job = paneJob(native);
    job.disarm();
    expect(native.createJob).not.toHaveBeenCalled();
    expect(native.setKillOnClose).not.toHaveBeenCalled();
  });
});

describe('extendedLimitInformation', () => {
  it('is the 64-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only LimitFlags set', () => {
    const armed = extendedLimitInformation(true);
    expect(armed).toHaveLength(EXTENDED_LIMIT_INFORMATION_SIZE);
    expect(armed.readUInt32LE(16)).toBe(0x2000 | 0x800);
    expect(extendedLimitInformation(false).readUInt32LE(16)).toBe(0x800);
    const rest = Buffer.concat([armed.subarray(0, 16), armed.subarray(20)]);
    expect(rest.every((byte) => byte === 0)).toBe(true);
  });
});

describe('PROCESS_BASIC_INFORMATION', () => {
  it('is read as the 64-bit layout, the parent pid in its last pointer-sized field', () => {
    // ExitStatus+pad, PebBaseAddress, AffinityMask, BasePriority+pad,
    // UniqueProcessId, InheritedFromUniqueProcessId: six 8-byte slots on x64
    // and arm64 alike. The OS test proves it against a real child.
    expect(PROCESS_BASIC_INFORMATION_SIZE).toBe(6 * 8);
    expect(PARENT_PID_OFFSET).toBe(5 * 8);
  });
});

describe('daemon wiring', () => {
  const src = (file: string) => fs.readFileSync(path.join(__dirname, '..', file), 'utf-8');

  it('disarms the job where the clean exit is decided, before any shutdown phase that can be cut short', () => {
    // Every caller's kill budget (tray full shutdown, Quit and Stop Sessions,
    // an update, the daemon's own 10s guard) can end shutdown() after any
    // await. Still armed then, the job would take every pane's tree with it.
    const daemon = src('index.ts');
    const start = daemon.indexOf('async function shutdown(');
    const body = daemon.slice(start, daemon.indexOf('\nasync function main', start));
    const decided = body.indexOf('shuttingDown = true;');
    const disarm = body.indexOf('paneJob.disarm();');
    expect(decided).toBeGreaterThan(0);
    expect(disarm).toBeGreaterThan(decided);
    const between = body.slice(decided, disarm);
    expect(between).not.toMatch(/\bawait\b/);
    expect(between).not.toContain('disposeAll');
    expect(disarm).toBeLessThan(body.search(/\bawait\b/));
    expect(disarm).toBeLessThan(body.indexOf('sessionManager.disposeAll();'));
  });

  it('contains only node-pty pane shells, at registration, against the mark taken before the spawn', () => {
    const manager = src('DaemonSessionManager.ts');
    const register = manager.slice(manager.indexOf('private registerSession('));
    expect(register.slice(0, 800)).toMatch(
      /if \(ptyBackend\(ptyProcess\) === 'node'\) this\.paneJob\?\.contain\(ptyProcess\.pid, spawnMark\);/,
    );
    for (const [create, spawn] of [['  createSession(', 'spawnPtySync('], ['  async createSessionAsync(', 'await spawnPty(']]) {
      const body = manager.slice(manager.indexOf(create));
      const mark = body.indexOf('const spawnMark = this.paneJob?.spawnMark() ?? null;');
      expect(mark).toBeGreaterThan(0);
      expect(mark).toBeLessThan(body.indexOf(spawn));
    }
  });
});
