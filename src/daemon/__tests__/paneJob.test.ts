// #2398 — the daemon's kill-on-close job for pane shells (paneJob.ts), against
// a fake kernel32: one job made lazily on the first pane, every pane's pid
// assigned, refusals logged once and never thrown, a clean exit disarming it.
// The real job on Windows: paneJob.os.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPaneJob, extendedLimitInformation, EXTENDED_LIMIT_INFORMATION_SIZE, type JobNative } from '../paneJob';

function fakeNative(overrides: Partial<JobNative> = {}) {
  const calls: string[] = [];
  const native: JobNative = {
    createJob: vi.fn(() => { calls.push('create'); return { job: 7n }; }),
    setKillOnClose: vi.fn((job: bigint, kill: boolean) => { calls.push(`kill:${job}:${kill}`); return 0; }),
    assign: vi.fn((job: bigint, pid: number) => { calls.push(`assign:${job}:${pid}`); return 0; }),
    ...overrides,
  };
  return { native, calls };
}

describe('createPaneJob', () => {
  it('makes one job on the first pane and assigns every pane shell to it', () => {
    const { native, calls } = fakeNative();
    const job = createPaneJob({ log: vi.fn(), native: () => native });
    expect(calls).toEqual([]);
    job.contain(101);
    job.contain(102);
    expect(calls).toEqual(['create', 'assign:7:101', 'assign:7:102']);
    expect(job.stats()).toEqual({ contained: 2, failed: 0 });
  });

  it('leaves a shell it cannot take running, logging each kind of refusal once', () => {
    const log = vi.fn();
    const { native } = fakeNative({ assign: vi.fn(() => 5) });
    const job = createPaneJob({ log, native: () => native });
    expect(() => { job.contain(101); job.contain(102); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 2 });
    expect(log.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('error 5'));
  });

  it('stays off when the job cannot be made, without trying again per pane', () => {
    const log = vi.fn();
    const createJob = vi.fn(() => ({ error: 8 }));
    const { native } = fakeNative({ createJob });
    const job = createPaneJob({ log, native: () => native });
    job.contain(101);
    job.contain(102);
    expect(createJob).toHaveBeenCalledOnce();
    expect(native.assign).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('error 8'));
  });

  it('does nothing where there is no native job (macOS, Linux, koffi missing)', () => {
    const job = createPaneJob({ log: vi.fn(), native: () => null });
    expect(() => { job.contain(101); job.disarm(); }).not.toThrow();
    expect(job.stats()).toEqual({ contained: 0, failed: 0 });
  });

  it('ignores a pid that is not a real one', () => {
    const { native } = fakeNative();
    const job = createPaneJob({ log: vi.fn(), native: () => native });
    job.contain(0);
    job.contain(-1);
    job.contain(Number.NaN);
    expect(native.createJob).not.toHaveBeenCalled();
  });

  it('disarms on a clean exit: kill-on-close is cleared, and no later shell joins', () => {
    const { native, calls } = fakeNative();
    const job = createPaneJob({ log: vi.fn(), native: () => native });
    job.contain(101);
    job.disarm();
    job.contain(102);
    expect(calls).toEqual(['create', 'assign:7:101', 'kill:7:false']);
  });

  it('disarming before any pane started has nothing to do', () => {
    const { native } = fakeNative();
    const job = createPaneJob({ log: vi.fn(), native: () => native });
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

  it('disarms the job in the clean shutdown, after the panes are disposed', () => {
    const daemon = src('index.ts');
    const start = daemon.indexOf('async function shutdown(');
    const body = daemon.slice(start, daemon.indexOf('\nasync function main', start));
    const dispose = body.indexOf('sessionManager.disposeAll();');
    expect(dispose).toBeGreaterThan(0);
    expect(body.indexOf('paneJob.disarm();')).toBeGreaterThan(dispose);
  });

  it('contains only node-pty pane shells, at registration', () => {
    const manager = src('DaemonSessionManager.ts');
    const register = manager.slice(manager.indexOf('private registerSession('));
    expect(register.slice(0, 600)).toMatch(/if \(ptyBackend\(ptyProcess\) === 'node'\) this\.paneJob\?\.contain\(ptyProcess\.pid\);/);
  });
});
