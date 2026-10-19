import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { stopTaskPaneTrees, type TaskTreeStopPorts } from '../taskTreeStop';
import { resetLingeringSurvivors } from '../../worktask/stopSessionsInDir';
import type { WorkerSessionInfo } from '../workerReclaim';

// #2388: the tree stop before an ended bot task's close. The renderer's
// close that follows ends every pane passed in, so each must still be idle
// and the close still due, inside the task folder or not.
const TASK = 'wtask-abc-12345678';
const DIR = '/w/task';

function rig(sessions: WorkerSessionInfo[]) {
  const destroyTree = vi.fn(async (id: string) => {
    const i = sessions.findIndex((s) => s.id === id);
    if (i >= 0) sessions.splice(i, 1);
    return { ok: true as const, killed: [] };
  });
  const ports: TaskTreeStopPorts = {
    folderOf: async () => DIR,
    listSessions: async () => sessions.map((s) => ({ ...s })),
    destroyTree,
    isAlive: () => false,
    sleep: async () => undefined,
    realpath: (p) => path.posix.resolve(p),
    platform: 'linux',
  };
  return { ports, destroyTree };
}

describe('stopTaskPaneTrees', () => {
  beforeEach(() => resetLingeringSurvivors());

  it('stops the folder\'s idle panes with their trees', async () => {
    const { ports, destroyTree } = rig([{ id: 'a', spawnCwd: DIR, commandRunning: false }, { id: 'other', spawnCwd: '/elsewhere', commandRunning: false }]);
    await stopTaskPaneTrees(ports, TASK, ['a', 'other'], () => true);
    expect(destroyTree.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('refuses, stopping nothing, when a pane outside the folder runs a command (the close would end it)', async () => {
    const { ports, destroyTree } = rig([{ id: 'a', spawnCwd: DIR, commandRunning: false }, { id: 'other', spawnCwd: '/elsewhere', commandRunning: true }]);
    await expect(stopTaskPaneTrees(ports, TASK, ['a', 'other'], () => true)).rejects.toThrow(/other of task .* run\(s\) again/);
    expect(destroyTree).not.toHaveBeenCalled();
  });

  it('refuses when the close is no longer due, even with no pane inside the folder', async () => {
    const { ports, destroyTree } = rig([{ id: 'other', spawnCwd: '/elsewhere', commandRunning: false }]);
    await expect(stopTaskPaneTrees(ports, TASK, ['other'], () => false)).rejects.toThrow(/no longer due/);
    expect(destroyTree).not.toHaveBeenCalled();
  });

  it('asks again right before each kill: a pane busy since the first kill is left', async () => {
    const sessions: WorkerSessionInfo[] = [{ id: 'a', spawnCwd: DIR, commandRunning: false }, { id: 'b', spawnCwd: DIR, commandRunning: false }];
    const { ports, destroyTree } = rig(sessions);
    destroyTree.mockImplementation(async (id: string) => {
      sessions.splice(sessions.findIndex((s) => s.id === id), 1);
      // The owner starts a command in the other pane meanwhile.
      const b = sessions.find((s) => s.id === 'b');
      if (b) b.commandRunning = true;
      return { ok: true as const, killed: [] };
    });
    await expect(stopTaskPaneTrees(ports, TASK, ['a', 'b'], () => true)).rejects.toThrow(/b of task .* run\(s\) again/);
    expect(destroyTree.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('never counts a dead session as busy, and refuses a folder that is not known', async () => {
    const { ports, destroyTree } = rig([{ id: 'a', spawnCwd: DIR, commandRunning: true, state: 'dead' } as WorkerSessionInfo]);
    await stopTaskPaneTrees(ports, TASK, ['a'], () => true);
    expect(destroyTree).toHaveBeenCalledWith('a');
    await expect(stopTaskPaneTrees({ ...ports, folderOf: async () => null }, TASK, ['a'], () => true)).rejects.toThrow(/not known/);
  });
});
