/**
 * Main's daemon exit line against real processes: a stand-in daemon dies with
 * a known code and the line carries it in hex. The Windows handle cases with a
 * scripted handle live here too, so they run on Windows; the platform-neutral
 * cases are in daemonExitWatch.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDaemonExitWatch, type DaemonExitWatchDeps } from '../daemonExitWatch';
import type { ProcessExitRead } from '../../pty/winSnapshotNative';
import { spawnedDaemonRegistryForTest, type SpawnedDaemonExit } from '../../../shared/daemon/daemonLauncherCore';

const children: ChildProcess[] = [];

/** A stand-in daemon: a Node process running `body`. */
function startStandIn(body: string): { child: ChildProcess; pid: number } {
  const child = spawn(process.execPath, ['-e', body], { stdio: 'ignore' });
  children.push(child);
  if (child.pid === undefined) throw new Error('stand-in daemon did not start');
  return { child, pid: child.pid };
}

afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill();
  }
  spawnedDaemonRegistryForTest.clear();
});

describe('daemon exit line (runtime)', () => {
  it('a daemon main spawned: logs its exit code in hex from the child exit event', async () => {
    const { child, pid } = startStandIn('setTimeout(() => process.exit(77), 50);');
    // What the launcher does for a daemon it spawns directly.
    spawnedDaemonRegistryForTest.track(pid);
    child.on('exit', (code, signal) => spawnedDaemonRegistryForTest.settle(pid, code, signal));

    const lines: string[] = [];
    createDaemonExitWatch(pid, true, { log: (level, msg) => { lines.push(`[${level}] ${msg}`); } });
    await new Promise<void>((resolve) => child.on('exit', () => setImmediate(resolve)));

    expect(lines).toEqual([`[warn] daemon pid ${pid} exited 0x0000004D (code 77) — child exit`]);
  });

  it.runIf(process.platform === 'win32')(
    'a daemon main found running: reads 0xC0000005 through the handle after a native-style kill',
    async () => {
      const { pid } = startStandIn('setInterval(() => {}, 1000);');

      const lines: string[] = [];
      // A daemon main found running rather than spawned: only the handle.
      const watch = createDaemonExitWatch(pid, false, {
        log: (level, msg) => { lines.push(`[${level}] ${msg}`); },
      });

      // End it the way a native fault does: no JS runs, the code is set by the OS.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi') as { load(n: string): { func(n: string, r: string, a: string[]): (...args: unknown[]) => number | bigint } };
      const k32 = koffi.load('kernel32.dll');
      const OpenProcess = k32.func('OpenProcess', 'int64', ['uint32', 'int', 'uint32']);
      const TerminateProcess = k32.func('TerminateProcess', 'int', ['int64', 'uint32']);
      const CloseHandle = k32.func('CloseHandle', 'int', ['int64']);
      const PROCESS_TERMINATE = 0x0001;
      const h = OpenProcess(PROCESS_TERMINATE, 0, pid);
      expect(BigInt(h)).not.toBe(0n);
      expect(TerminateProcess(h, 0xc0000005)).toBeTruthy();
      CloseHandle(h);

      await watch.report('socket close');
      expect(lines).toEqual([`[warn] daemon pid ${pid} exited 0xC0000005 (access violation) — at socket close`]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'a daemon still alive after the budget is logged as running',
    async () => {
      const { pid } = startStandIn('setInterval(() => {}, 1000);');
      const lines: string[] = [];
      const watch = createDaemonExitWatch(pid, false, {
        log: (level, msg) => { lines.push(`[${level}] ${msg}`); },
        budgetMs: 300,
      });
      await watch.report('health probe hang');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^\\[warn\\] daemon pid ${pid} still running \\d+ms after health probe hang — exit code unavailable: it has not exited$`));
    },
  );
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

/** Deps for the Windows path: an injected handle, a virtual clock. */
function winHarness(over: Partial<DaemonExitWatchDeps> = {}) {
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

/** A child-exit source the test fires by hand. */
function childExitSource() {
  let deliver: ((exit: SpawnedDaemonExit) => void) | null = null;
  return {
    onChildExit: (_pid: number, cb: (exit: SpawnedDaemonExit) => void) => { deliver = cb; return () => { deliver = null; }; },
    exit: (exit: SpawnedDaemonExit) => deliver?.(exit),
  };
}

describe('createDaemonExitWatch (Windows handle)', () => {
  it('logs the exit code in hex once the process has exited', async () => {
    const h = scriptedHandle([{ state: 'running' }, { state: 'running' }, { state: 'exited', code: 0xc0000005 }]);
    const { lines, deps } = winHarness({ openHandle: () => h.handle });
    const watch = createDaemonExitWatch(4321, false, deps);

    await watch.report('socket close');

    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 4321 exited 0xC0000005 (access violation) — at socket close' }]);
    expect(h.state.closed).toBe(true);
  });

  it('logs a clean exit at info', async () => {
    const h = scriptedHandle([{ state: 'exited', code: 0 }]);
    const { lines, deps } = winHarness({ openHandle: () => h.handle });
    await createDaemonExitWatch(7, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'info', msg: 'daemon pid 7 exited 0x00000000 (clean exit) — at socket close' }]);
  });

  it('says so when the daemon is still running at the end of the budget', async () => {
    const h = scriptedHandle([{ state: 'running' }]);
    const { lines, deps } = winHarness({ openHandle: () => h.handle, budgetMs: 3000 });
    await createDaemonExitWatch(99, false, deps).report('health probe hang');
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toMatch(/^daemon pid 99 still running \d+ms after health probe hang — exit code unavailable: it has not exited$/);
    expect(h.state.closed).toBe(true);
  });

  it('says why when no handle could be opened', async () => {
    const { lines, deps } = winHarness({ openHandle: () => ({ failure: 'OpenProcess failed (error 5)' }) });
    await createDaemonExitWatch(12, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 12 socket close, exit code unavailable: OpenProcess failed (error 5)' }]);
  });

  it('says why when the pid is unknown', async () => {
    const { lines, deps } = winHarness({ openHandle: () => { throw new Error('must not open'); } });
    await createDaemonExitWatch(null, false, deps).report('socket close');
    expect(lines[0].msg).toBe('daemon pid ? socket close, exit code unavailable: the launcher did not report the daemon pid');
  });

  it('logs once, however many reports ask', async () => {
    const h = scriptedHandle([{ state: 'exited', code: 1 }]);
    const { lines, deps } = winHarness({ openHandle: () => h.handle });
    const watch = createDaemonExitWatch(5, false, deps);
    await Promise.all([watch.report('socket close'), watch.report('health probe hang')]);
    await watch.report('socket close');
    expect(lines).toHaveLength(1);
  });

  it('dispose closes the handle without logging; a report already running still finishes', async () => {
    const quiet = scriptedHandle([{ state: 'running' }]);
    const a = winHarness({ openHandle: () => quiet.handle });
    createDaemonExitWatch(1, false, a.deps).dispose();
    expect(quiet.state.closed).toBe(true);
    expect(a.lines).toEqual([]);

    const later = scriptedHandle([{ state: 'running' }, { state: 'exited', code: 3 }]);
    const b = winHarness({ openHandle: () => later.handle });
    const watch = createDaemonExitWatch(2, false, b.deps);
    const reported = watch.report('socket close');
    watch.dispose();
    expect(later.state.closed).toBe(false);
    await reported;
    expect(b.lines[0].msg).toBe('daemon pid 2 exited 0x00000003 (abort()) — at socket close');
    expect(later.state.closed).toBe(true);
  });

  it('a found daemon ignores a launcher record left by an earlier daemon with the same pid (Codex P2)', async () => {
    // The pid was reused: the record says an older process exited 1. The
    // launcher withholds an ended record when asked for live ones only.
    const stale = (_pid: number, cb: (exit: SpawnedDaemonExit) => void, liveOnly: boolean) => {
      if (liveOnly) return null;
      cb({ code: 1, signal: null });
      return () => { /* delivered */ };
    };
    const h = scriptedHandle([{ state: 'running' }, { state: 'exited', code: 0xc0000005 }]);
    const { lines, deps } = winHarness({ onChildExit: stale, openHandle: () => h.handle });
    await createDaemonExitWatch(66, false, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 66 exited 0xC0000005 (access violation) — at socket close' }]);
  });

  it('a failed handle read waits for the child exit event instead of giving up (Codex P2)', async () => {
    const src = childExitSource();
    let clock = 0;
    const h = scriptedHandle([{ state: 'failed', failure: 'GetExitCodeProcess failed (error 6)' }]);
    const { lines, deps } = winHarness({
      onChildExit: src.onChildExit,
      openHandle: () => h.handle,
      now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock >= 300) src.exit({ code: 0xc0000005, signal: null }); },
    });
    await createDaemonExitWatch(31, true, deps).report('socket close');
    expect(lines).toEqual([{ level: 'warn', msg: 'daemon pid 31 exited 0xC0000005 (access violation) — child exit' }]);
  });
});
