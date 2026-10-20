// Whether a pane runs nothing, so a writer may type into it: the tracked agent
// is not running (not proven gone counts as running) and the shell is idle.
import { describe, expect, it, vi } from 'vitest';
import { paneFree, type PaneFreeDeps } from '../paneFree';

function deps(over: Partial<PaneFreeDeps> = {}): PaneFreeDeps {
  return {
    shellIdle: async () => true,
    trackedAgentPid: () => 4242,
    isDefinitelyDead: async () => false,
    isRunning: async () => true,
    ...over,
  };
}

describe('paneFree', () => {
  it('an agent that exited frees the pane even where isRunning is true for any pid (Windows, #2507)', async () => {
    expect(await paneFree(deps({ isDefinitelyDead: async () => true, isRunning: async () => true }))).toBe(true);
  });

  it('a live agent keeps the pane busy, and the shell is not asked', async () => {
    const shellIdle = vi.fn(async () => true);
    expect(await paneFree(deps({ shellIdle }))).toBe(false);
    expect(shellIdle).not.toHaveBeenCalled();
  });

  it('a liveness probe that fails counts as running', async () => {
    expect(await paneFree(deps({ isDefinitelyDead: async () => { throw new Error('tasklist timed out'); } }))).toBe(false);
  });

  it('a stopped agent (POSIX) is left to the shell check', async () => {
    expect(await paneFree(deps({ isRunning: async () => false, shellIdle: async () => false }))).toBe(false);
    expect(await paneFree(deps({ isRunning: async () => false, shellIdle: async () => true }))).toBe(true);
  });

  it('with no tracked agent the shell decides', async () => {
    const isDefinitelyDead = vi.fn(async () => true);
    expect(await paneFree(deps({ trackedAgentPid: () => undefined, isDefinitelyDead }))).toBe(true);
    expect(await paneFree(deps({ trackedAgentPid: () => undefined, shellIdle: async () => false }))).toBe(false);
    expect(isDefinitelyDead).not.toHaveBeenCalled();
  });

  it('a shell with children stays busy after its tracked agent exited', async () => {
    expect(await paneFree(deps({ isDefinitelyDead: async () => true, shellIdle: async () => false }))).toBe(false);
  });
});
