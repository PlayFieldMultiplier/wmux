// @wmux-lane unit — every case injects the platform and a fake handle or
// child-exit source; nothing opens a real process or calls into Windows.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDaemonExitWatch,
  describeExitCode,
  hexExitCode,
  type DaemonExitWatchDeps,
} from '../daemonExitWatch';
import type { ProcessExitRead } from '../../pty/winSnapshotNative';
import type { SpawnedDaemonExit } from '../../../shared/daemon/daemonLauncherCore';

describe('describeExitCode', () => {
  it('prints Windows exit codes as unsigned hex with what they mean', () => {
    expect(describeExitCode(0xc0000005)).toBe('0xC0000005 (access violation)');
    // Node can hand the same code over signed; it is the same exit.
    expect(describeExitCode(-1073741819)).toBe('0xC0000005 (access violation)');
    expect(describeExitCode(0xc0000409)).toBe('0xC0000409 (fail-fast / stack buffer overrun)');
    expect(describeExitCode(0)).toBe('0x00000000 (clean exit)');
  });

  it('names the code Electron’s Crashpad client ends a crashed daemon with', () => {
    // What the packaged daemon exited with when node-pty faulted (#2398).
    expect(describeExitCode(0xffff7003)).toBe('0xFFFF7003 (native crash; Crashpad had no handler, the fault code is lost)');
  });

  it('gives an unknown code its decimal value', () => {
    expect(describeExitCode(77)).toBe('0x0000004D (code 77)');
    expect(hexExitCode(0xdeadbeef)).toBe('0xDEADBEEF');
  });
});

/** A fake handle whose reads come from a script; the last entry repeats. */
function scriptedHandle(reads: ProcessExitRead[]) {
  const state = { reads: 0, closed: false };
  return {
    state,
    handle: {
      read: (): ProcessExitRead => reads[Math.min(state.reads++, reads.length - 1)],
      close: () => { state.closed = true; },
    },
  };
}

function harness(over: Partial<DaemonExitWatchDeps> = {}) {
  const lines: Array<{ level: string; msg: string }> = [];
  let clock = 0;
  const deps: DaemonExitWatchDeps = {
    log: (level, msg) => { lines.push({ level, msg }); },
    platform: 'win32',
    onChildExit: () => null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  };
  return { lines, deps };
}

describe('createDaemonExitWatch (Windows handle)', () => {
  it('logs the exit code in hex once the process has exited', async () => {
    const h = scriptedHandle([{ state: 'running' }, { state: 'running' }, { state: 'exited', code: 0xc0000005 }]);
    const { lines, deps } = harness({ openHandle: () => h.handle });
    const watch = createDaemonExitWatch(4321, false, deps);

    await watch.report('socket close');

    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 4321 exited 0xC0000005 (access violation) — at socket close' }]);
    expect(h.state.closed).toBe(true);
  });

  it('logs a clean exit at info', async () => {
    const h = scriptedHandle([{ state: 'exited', code: 0 }]);
    const { lines, deps } = harness({ openHandle: () => h.handle });
    await createDaemonExitWatch(7, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'info', msg: 'daemon pid 7 exited 0x00000000 (clean exit) — at socket close' }]);
  });

  it('says so when the daemon is still running at the end of the budget', async () => {
    const h = scriptedHandle([{ state: 'running' }]);
    const { lines, deps } = harness({ openHandle: () => h.handle, budgetMs: 3000 });
    await createDaemonExitWatch(99, false, deps).report('health probe hang');
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toMatch(/^daemon pid 99 still running \d+ms after health probe hang — exit code unavailable: it has not exited$/);
    expect(h.state.closed).toBe(true);
  });

  it('says why when no handle could be opened', async () => {
    const { lines, deps } = harness({ openHandle: () => ({ failure: 'OpenProcess failed (error 5)' }) });
    await createDaemonExitWatch(12, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 12 socket close, exit code unavailable: OpenProcess failed (error 5)' }]);
  });

  it('says why when the pid is unknown', async () => {
    const { lines, deps } = harness({ openHandle: () => { throw new Error('must not open'); } });
    await createDaemonExitWatch(null, false, deps).report('socket close');
    expect(lines[0].msg).toBe('daemon pid ? socket close, exit code unavailable: the launcher did not report the daemon pid');
  });

  it('logs once, however many reports ask', async () => {
    const h = scriptedHandle([{ state: 'exited', code: 1 }]);
    const { lines, deps } = harness({ openHandle: () => h.handle });
    const watch = createDaemonExitWatch(5, false, deps);
    await Promise.all([watch.report('socket close'), watch.report('health probe hang')]);
    await watch.report('socket close');
    expect(lines).toHaveLength(1);
  });

  it('dispose closes the handle without logging; a report already running still finishes', async () => {
    const quiet = scriptedHandle([{ state: 'running' }]);
    const a = harness({ openHandle: () => quiet.handle });
    createDaemonExitWatch(1, false, a.deps).dispose();
    expect(quiet.state.closed).toBe(true);
    expect(a.lines).toEqual([]);

    const later = scriptedHandle([{ state: 'running' }, { state: 'exited', code: 3 }]);
    const b = harness({ openHandle: () => later.handle });
    const watch = createDaemonExitWatch(2, false, b.deps);
    const reported = watch.report('socket close');
    watch.dispose();
    expect(later.state.closed).toBe(false);
    await reported;
    expect(b.lines[0].msg).toBe('daemon pid 2 exited 0x00000003 (abort()) — at socket close');
    expect(later.state.closed).toBe(true);
  });
});

describe('createDaemonExitWatch (spawned child)', () => {
  function childExitSource() {
    let deliver: ((exit: SpawnedDaemonExit) => void) | null = null;
    return {
      onChildExit: (_pid: number, cb: (exit: SpawnedDaemonExit) => void) => { deliver = cb; return () => { deliver = null; }; },
      exit: (exit: SpawnedDaemonExit) => deliver?.(exit),
    };
  }

  it('logs the child exit as soon as it arrives, with no socket close needed', () => {
    const src = childExitSource();
    const { lines, deps } = harness({ platform: 'linux', onChildExit: src.onChildExit });
    createDaemonExitWatch(321, true, deps);
    src.exit({ code: null, signal: 'SIGKILL' });
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 321 was killed by SIGKILL — child exit' }]);
  });

  it('a socket close before the exit event waits for it', async () => {
    const src = childExitSource();
    let clock = 0;
    const { lines, deps } = harness({
      platform: 'linux',
      onChildExit: src.onChildExit,
      now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock >= 300) src.exit({ code: 77, signal: null }); },
    });
    await createDaemonExitWatch(8, true, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 8 exited 0x0000004D (code 77) — child exit' }]);
  });

  it('a found daemon ignores a launcher record left by an earlier daemon with the same pid (Codex P2)', async () => {
    // The pid was reused: the record says an older process exited 1.
    const stale = (_pid: number, cb: (exit: SpawnedDaemonExit) => void) => { cb({ code: 1, signal: null }); return () => { /* delivered */ }; };
    const h = scriptedHandle([{ state: 'running' }, { state: 'exited', code: 0xc0000005 }]);
    const { lines, deps } = harness({ onChildExit: stale, openHandle: () => h.handle });
    await createDaemonExitWatch(66, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 66 exited 0xC0000005 (access violation) — at socket close' }]);
  });

  it('on POSIX, a daemon this process did not spawn has no exit code to read', async () => {
    const { lines, deps } = harness({ platform: 'darwin' });
    await createDaemonExitWatch(55, false, deps).report('socket close');
    expect(lines[0].msg).toBe(
      'daemon pid 55 socket close, exit code unavailable: this process did not spawn the daemon, so it gets no exit event',
    );
  });
});

describe('launcher wiring', () => {
  it('a directly spawned daemon is registered, and its child exit settles the record', () => {
    // spawnDirect is not reachable from a unit test (it spawns the real
    // daemon); this pins the two lines the runtime test stands in for.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'daemon', 'daemonLauncherCore.ts'), 'utf-8');
    const at = src.indexOf('const spawnDirect = () => {');
    const body = src.slice(at, src.indexOf('watch({', at));
    expect(body).toMatch(/trackSpawnedDaemon\(spawnedPid\);\s*child\.on\('exit', \(code, signal\) => settleSpawnedDaemon\(spawnedPid, code, signal\)\);/);
  });
});
