// paneFree against the real process checks: an agent pid that has exited
// frees the pane on every OS, a live one keeps it busy (#2507: on Windows
// ProcessMonitor.isRunning is true for an exited pid too).
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ProcessMonitor } from '../ProcessMonitor';
import { paneFree } from '../paneFree';

function pidOf(child: { pid?: number }): number {
  if (child.pid === undefined) throw new Error('the test process did not start');
  return child.pid;
}

function realDeps(pid: number) {
  return {
    shellIdle: async () => true,
    trackedAgentPid: () => pid,
    isDefinitelyDead: (p: number) => ProcessMonitor.isDefinitelyDead(p),
    isRunning: (p: number) => ProcessMonitor.isRunning(p),
  };
}

describe('paneFree with the real process checks', () => {
  it('an agent pid that has exited frees the pane', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = pidOf(child);
    await once(child, 'exit');
    expect(await paneFree(realDeps(pid))).toBe(true);
  });

  it('a live agent pid keeps the pane busy', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      expect(await paneFree(realDeps(pidOf(child)))).toBe(false);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
});
