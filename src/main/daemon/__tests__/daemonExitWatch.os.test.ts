/**
 * Main's daemon exit line against real processes: a stand-in daemon dies with
 * a known code and the line carries it in hex.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDaemonExitWatch } from '../daemonExitWatch';
import { spawnedDaemonRegistryForTest } from '../../../shared/daemon/daemonLauncherCore';

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
