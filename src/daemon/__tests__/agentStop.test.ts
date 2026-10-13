// The stop of a pane's agent: SIGTERM, then a kill of whatever of its tree is
// still the same process after the grace; nothing outside that tree.
import { describe, expect, it, vi } from 'vitest';
import { stopAgentTree } from '../agentStop';
import type { ProcessTreeEntry } from '../AgentProcessTracker';

const root: ProcessTreeEntry = { pid: 100, ppid: 10, name: 'claude' };
const mcp: ProcessTreeEntry = { pid: 101, ppid: 100, name: 'node' };

describe('stopAgentTree', () => {
  it('no agent: nothing is signalled', async () => {
    const kill = vi.fn();
    expect(await stopAgentTree({ tree: async () => null, stillRunning: async () => [], kill })).toEqual({ ok: true, stopped: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it('asks the agent to exit and kills an MCP server it left behind', async () => {
    const alive = new Set([100, 101]);
    const kill = vi.fn((pid: number) => { if (pid === 100) alive.delete(100); else alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM'], [101, 'SIGKILL']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
  });

  it('an agent that survives even the kill is reported, not hidden', async () => {
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [] }),
      stillRunning: async (es) => [...es],
      kill: () => undefined,
      sleep: async () => undefined,
      graceMs: 400,
    });
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });
});

describe('stopAgentTree failures', () => {
  it('a captured process that survives its kill fails the stop even when the agent exited', async () => {
    const alive = new Set([100, 101]);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill: (pid) => { if (pid === 100) alive.delete(100); else throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      sleep: async () => undefined,
    });
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });

  it('a process table that cannot be read fails the stop instead of reading as "nothing runs"', async () => {
    await expect(stopAgentTree({ tree: async () => { throw new Error('ps failed'); }, stillRunning: async () => [], kill: vi.fn() })).rejects.toThrow('ps failed');
  });
});
