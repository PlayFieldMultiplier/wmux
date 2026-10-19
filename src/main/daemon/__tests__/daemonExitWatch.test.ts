// @wmux-lane unit — every case injects the platform and a fake child-exit
// source; nothing opens a real process. The Windows handle cases live in
// daemonExitWatch.os.test.ts, so they run on Windows.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDaemonExitWatch,
  describeExitCode,
  hexExitCode,
  type DaemonExitWatchDeps,
} from '../daemonExitWatch';
import {
  onSpawnedDaemonExit,
  spawnedDaemonRegistryForTest,
  type SpawnedDaemonExit,
} from '../../../shared/daemon/daemonLauncherCore';

describe('describeExitCode', () => {
  it('prints Windows exit codes as unsigned hex with what they mean', () => {
    expect(describeExitCode(0xc0000005)).toBe('0xC0000005 (access violation)');
    // Node can hand the same code over signed; it is the same exit.
    expect(describeExitCode(-1073741819)).toBe('0xC0000005 (access violation)');
    expect(describeExitCode(0xc0000409)).toBe('0xC0000409 (fail-fast / stack buffer overrun)');
    expect(describeExitCode(0)).toBe('0x00000000 (clean exit)');
  });

  it('names the code Electron’s Crashpad client ends a crashed daemon with', () => {
    // What a packaged daemon exited with in one of two runs where node-pty faulted (#2398).
    expect(describeExitCode(0xffff7003)).toBe('0xFFFF7003 (native crash; Crashpad had no handler, the fault code is lost)');
  });

  it('names Node’s own abort on Windows (a heap out of memory exits 134 there, not the CRT’s 3)', () => {
    expect(describeExitCode(134)).toBe('0x00000086 (Node abort: out of memory or process.abort(); see the crash-reports folder)');
  });

  it('gives an unknown code its decimal value', () => {
    expect(describeExitCode(77)).toBe('0x0000004D (code 77)');
    expect(hexExitCode(0xdeadbeef)).toBe('0xDEADBEEF');
  });
});

function harness(over: Partial<DaemonExitWatchDeps> = {}) {
  const lines: Array<{ level: string; msg: string }> = [];
  let clock = 0;
  const deps: DaemonExitWatchDeps = {
    log: (level, msg) => { lines.push({ level, msg }); },
    platform: 'linux',
    onChildExit: () => null,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  };
  return { lines, deps };
}

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

  it('a reconnect to a daemon this process spawned earlier still gets its child exit (Codex P2)', () => {
    const src = childExitSource();
    const { lines, deps } = harness({ platform: 'linux', onChildExit: src.onChildExit });
    createDaemonExitWatch(404, false, deps);
    src.exit({ code: 1, signal: null });
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 404 exited 0x00000001 (exit(1)) — child exit' }]);
  });

  it('on POSIX, a daemon this process did not spawn has no exit code to read', async () => {
    const { lines, deps } = harness({ platform: 'darwin' });
    await createDaemonExitWatch(55, false, deps).report('socket close');
    expect(lines[0].msg).toBe(
      'daemon pid 55 socket close, exit code unavailable: this process did not spawn the daemon, so it gets no exit event',
    );
  });
});

describe('launcher child-exit record', () => {
  it('hands an ended record only to a caller that just spawned the daemon', () => {
    spawnedDaemonRegistryForTest.clear();
    spawnedDaemonRegistryForTest.track(900);
    spawnedDaemonRegistryForTest.settle(900, 3, null);
    const got: SpawnedDaemonExit[] = [];
    expect(onSpawnedDaemonExit(900, (e) => got.push(e), true)).toBeNull();
    expect(got).toEqual([]);
    expect(onSpawnedDaemonExit(900, (e) => got.push(e), false)).not.toBeNull();
    expect(got).toEqual([{ code: 3, signal: null }]);
  });

  it('a live record is followed either way, and an unknown pid is not', () => {
    spawnedDaemonRegistryForTest.clear();
    spawnedDaemonRegistryForTest.track(901);
    const got: SpawnedDaemonExit[] = [];
    expect(onSpawnedDaemonExit(901, (e) => got.push(e), true)).not.toBeNull();
    spawnedDaemonRegistryForTest.settle(901, null, 'SIGKILL');
    expect(got).toEqual([{ code: null, signal: 'SIGKILL' }]);
    expect(onSpawnedDaemonExit(999, () => { /* none */ }, false)).toBeNull();
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
