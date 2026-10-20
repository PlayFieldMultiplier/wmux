// #2398 — the daemon's kill-on-close job for pane shells (paneJob.ts), against
// a fake kernel32: one job made lazily on the first pane, every pane's shell
// assigned once it is proven to be the daemon's own fresh child, refusals
// logged once and never thrown, a clean exit disarming it.
// The real job on Windows: paneJob.os.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPaneJob,
  extendedLimitInformation,
  EXTENDED_LIMIT_INFORMATION_SIZE,
  type JobNative,
  type ShellIdentity,
} from '../paneJob';

const DAEMON = 4000;
const MARK = 1_000n;

function fakeNative(overrides: Partial<JobNative> = {}) {
  const calls: string[] = [];
  const closed: bigint[] = [];
  const native: JobNative = {
    createJob: vi.fn(() => { calls.push('create'); return { job: 7n }; }),
    setKillOnClose: vi.fn((job: bigint, kill: boolean) => { calls.push(`kill:${job}:${kill}`); return 0; }),
    open: vi.fn((pid: number) => ({ handle: BigInt(pid) })),
    assign: vi.fn((job: bigint, handle: bigint) => { calls.push(`assign:${job}:${handle}`); return 0; }),
    close: vi.fn((handle: bigint) => { closed.push(handle); }),
    ...overrides,
  };
  return { native, calls, closed };
}

type Who = { ppid: number; createdAt: bigint } | null;

/** Every pid reads as the daemon's child, created after MARK, unless listed. */
function fakeIdentity(who: Record<number, Who> = {}): ShellIdentity {
  return {
    now: () => MARK,
    read: (pid) => (pid in who ? who[pid] : { ppid: DAEMON, createdAt: MARK + 1n }),
  };
}

const newLog = () => vi.fn<(level: 'info' | 'warn', message: string) => void>();
type Log = ReturnType<typeof newLog>;

function paneJob(native: JobNative | null, opts: { log?: Log; identity?: ShellIdentity | null } = {}) {
  return createPaneJob({
    log: opts.log ?? newLog(),
    native: () => native,
    identity: () => (opts.identity === undefined ? fakeIdentity() : opts.identity),
    daemonPid: DAEMON,
  });
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
    expect(calls).toEqual(['create', 'assign:7:101', 'assign:7:102']);
    expect(closed).toEqual([101n, 102n]);
    expect(job.stats()).toEqual({ contained: 2, failed: 0 });
  });

  it('leaves a shell it cannot take running, logging each kind of refusal once', () => {
    const log = newLog();
    const { native, closed } = fakeNative({ assign: vi.fn(() => 5) });
    const job = paneJob(native, { log });
    expect(() => { job.contain(101, MARK); job.contain(102, MARK); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(closed).toEqual([101n, 102n]);
    expect(warnings(log)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('error 5'));
  });

  it('never assigns a pid whose process the daemon did not spawn (a pid reused after the shell exited)', () => {
    const log = newLog();
    const { native, closed } = fakeNative();
    const job = paneJob(native, {
      log,
      identity: fakeIdentity({ 101: { ppid: 9999, createdAt: MARK + 1n }, 102: { ppid: 9999, createdAt: MARK + 2n } }),
    });
    job.contain(101, MARK);
    job.contain(102, MARK);
    expect(native.assign).not.toHaveBeenCalled();
    // The pid stayed pinned through the check and was let go after it.
    expect(closed).toEqual([101n, 102n]);
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(warnings(log)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('parent is pid 9999'));
  });

  it('never assigns a process created before the spawn, though it names the daemon as parent', () => {
    // Windows never re-parents an orphan: a process whose parent died before
    // this daemon got that pid still names it.
    const { native } = fakeNative();
    const job = paneJob(native, { identity: fakeIdentity({ 101: { ppid: DAEMON, createdAt: MARK - 1n } }) });
    job.contain(101, MARK);
    expect(native.assign).not.toHaveBeenCalled();
    expect(job.stats()).toEqual({ contained: 0, failed: 1 });
  });

  it('never assigns a pid it cannot identify, or one with no spawn mark', () => {
    const { native } = fakeNative();
    const job = paneJob(native, { identity: fakeIdentity({ 101: null }) });
    job.contain(101, MARK);
    job.contain(102, null);
    expect(native.assign).not.toHaveBeenCalled();
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
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
    expect(() => { job.contain(101, job.spawnMark()); job.disarm(); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 0 });
  });

  it('does nothing without a way to identify the shell', () => {
    const { native } = fakeNative();
    const job = paneJob(native, { identity: null });
    expect(job.spawnMark()).toBeNull();
    job.contain(101, null);
    expect(native.createJob).not.toHaveBeenCalled();
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

  it('an identity read or clock that throws is contained the same way', () => {
    const log = newLog();
    const { native } = fakeNative();
    const job = paneJob(native, {
      log,
      identity: { now: () => { throw new Error('clock'); }, read: () => { throw new Error('read'); } },
    });
    expect(job.spawnMark()).toBeNull();
    expect(() => job.contain(101, MARK)).not.toThrow();
    expect(native.assign).not.toHaveBeenCalled();
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
    expect(calls).toEqual(['create', 'assign:7:101', 'kill:7:false']);
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
