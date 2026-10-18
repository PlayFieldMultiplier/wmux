import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import type { WorkspaceListEntry } from '../../../shared/workspaceMirror';
import { createTaskWorkspaceLiveness, type TaskWorkspaceLivenessPorts } from '../taskWorkspaceLiveness';
import type { WorkerSessionInfo } from '../workerReclaim';
import { FanOutGuards, refreshDormantTaskWorkspaces, setDormantRefresh, setDormantTaskWorkspaces } from '../../worktask/fanoutGuards';

const REFRESH_MS = 10_000;

type Task = { id: string; status: LedgerEntry['status']; pty: string };

/** A world of task workspaces (`tasks`, by workspace id), the mirror's view
 *  of them (null: not pushed yet) and the daemon's sessions. */
function world(tasks: Record<string, Task>) {
  const t = { now: 1_000_000 };
  const state: {
    entries: WorkspaceListEntry[] | null;
    sessions: WorkerSessionInfo[] | 'down' | 'hang';
  } = { entries: null, sessions: [] };
  const open = (): void => {
    state.entries = Object.entries(tasks).map(([ws, task]) => ({ id: ws, name: ws, ptyIds: [task.pty] }) as WorkspaceListEntry);
  };
  const reads = vi.fn();
  const warn = vi.fn();
  const rowOf = (task: Task | undefined): LedgerEntry | null => (task ? ({ id: task.id, status: task.status } as LedgerEntry) : null);
  const ports: TaskWorkspaceLivenessPorts = {
    entries: () => (state.entries ? [...state.entries] : null),
    listSessions: async () => {
      reads();
      if (state.sessions === 'down') throw new Error('the daemon is not connected');
      if (state.sessions === 'hang') return new Promise<WorkerSessionInfo[]>(() => undefined);
      const answer = state.sessions;
      // A daemon round-trip: answered on a later turn of the event loop.
      await new Promise((r) => setTimeout(r, 0));
      return answer;
    },
    workspaceRow: (ws) => rowOf(tasks[ws]),
    row: (taskId) => rowOf(Object.values(tasks).find((x) => x.id === taskId)),
    records: () => [],
    recordedSessions: () => [],
    sessionRecordOf: () => null,
    refreshMs: REFRESH_MS,
    now: () => t.now,
    warn,
  };
  const liveness = createTaskWorkspaceLiveness(ports);
  const guards = new FanOutGuards({
    dir: fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wmux-task-liveness-')),
    now: () => t.now,
    openWorkspaceIds: () => Object.keys(tasks),
    ledgerTaskOwner: () => null,
  });
  for (const ws of Object.keys(tasks)) guards.markTask(ws, 'ws-owner');
  setDormantTaskWorkspaces(liveness.dormant);
  setDormantRefresh(liveness.refresh);
  return { t, state, open, reads, warn, liveness, guards };
}

const exited = (pty: string): WorkerSessionInfo => ({ id: pty, agentProcessAlive: false });
const running = (pty: string): WorkerSessionInfo => ({ id: pty, agentProcessAlive: true });

afterEach(() => {
  setDormantTaskWorkspaces(null);
  setDormantRefresh(null);
  vi.useRealTimers();
});

describe('task workspace liveness (#2387)', () => {
  it('a read before the workspace list is pushed is not kept: the previous values stay and the next read is not held off', async () => {
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'cancelled', pty: 'p-b' },
    });
    w.state.sessions = [exited('p-a'), exited('p-b')];
    // Cold start: the renderer has not pushed its tree yet.
    await w.liveness.refresh();
    // Pushed now, at the same instant: a read is made, not answered from the
    // failed one as if it were fresh.
    w.open();
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect([...w.liveness.dormant()].sort()).toEqual(['ws-a', 'ws-b']);
    expect([...w.liveness.idle.get()].sort()).toEqual(['ws-a', 'ws-b']);
    expect(w.guards.liveTaskCount()).toBe(0);

    // A later read that finds no tree keeps the last good values.
    w.t.now += REFRESH_MS + 1;
    w.state.entries = null;
    await w.liveness.refresh();
    expect([...w.liveness.dormant()].sort()).toEqual(['ws-a', 'ws-b']);
    expect([...w.liveness.idle.get()].sort()).toEqual(['ws-a', 'ws-b']);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it('a live-cap check after refreshDormantTaskWorkspaces counts on the fresh read', async () => {
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'failed', pty: 'p-b' },
    });
    w.open();
    // The last read saw both agents still running after their tasks ended.
    w.state.sessions = [running('p-a'), running('p-b')];
    await w.liveness.refresh();
    expect(w.guards.liveTaskCount()).toBe(2);
    // Both agents exit; the snapshot is stale.
    w.state.sessions = [exited('p-a'), exited('p-b')];
    w.t.now += REFRESH_MS + 1;
    expect(w.guards.liveTaskCount()).toBe(2);
    await refreshDormantTaskWorkspaces();
    expect(w.guards.liveTaskCount()).toBe(0);
  });

  it('with no good read yet, the ledger decides: ended tasks hold no slot, and it says so once', async () => {
    const w = world({
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-cancel': { id: 't-cancel', status: 'cancelled', pty: 'p-cancel' },
      'ws-run': { id: 't-run', status: 'working', pty: 'p-run' },
    });
    w.open();
    w.state.sessions = 'down';
    await refreshDormantTaskWorkspaces();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-run']);
    expect(w.guards.reserve('k', 7)).toEqual({ ok: true });
    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toBe('[fanout] liveness unknown: counting 2 ended task workspace(s) as dormant from the ledger');
  });

  it('an ended task an agent was last seen in keeps its slot while the daemon cannot be read', async () => {
    const w = world({
      'ws-agent': { id: 't-agent', status: 'completed', pty: 'p-agent' },
      'ws-gone': { id: 't-gone', status: 'completed', pty: 'p-gone' },
    });
    // The first read comes before the tree; the next one sees an agent in ws-agent.
    w.state.sessions = [running('p-agent'), exited('p-gone')];
    await w.liveness.refresh();
    w.open();
    await w.liveness.refresh();
    // Then the daemon drops.
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-agent']);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it('an empty workspace list is not kept: the restored tree is read at once', async () => {
    const w = world({
      'ws-agent': { id: 't-agent', status: 'completed', pty: 'p-agent' },
      'ws-gone': { id: 't-gone', status: 'completed', pty: 'p-gone' },
    });
    // Pushed empty first, then the restored tree at the same instant: a read is made.
    w.state.entries = [];
    w.state.sessions = [running('p-agent'), exited('p-gone')];
    await w.liveness.refresh();
    expect(w.reads).not.toHaveBeenCalled();
    w.open();
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-agent']);
    expect(w.warn).not.toHaveBeenCalled();
  });

  it('a task that ends after the last good read is dormant from the ledger once reads fail, and it says so', async () => {
    const tasks: Record<string, Task> = { 'ws-x': { id: 't-x', status: 'working', pty: 'p-x' } };
    const w = world(tasks);
    w.open();
    // The last good read: the task is still working, its agent has exited.
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-x']);
    // The task completes, then the daemon cannot be read.
    tasks['ws-x'].status = 'completed';
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.guards.liveTaskWorkspaces()).toEqual([]);
    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toBe('[fanout] liveness unknown: counting 1 ended task workspace(s) as dormant from the ledger');
  });

  it('a fresh read that never answers holds the check for 2 s at most, then the ledger decides', async () => {
    vi.useFakeTimers();
    const w = world({
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-run': { id: 't-run', status: 'working', pty: 'p-run' },
    });
    w.open();
    w.state.sessions = 'hang';
    let settled = false;
    void refreshDormantTaskWorkspaces().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-run']);
    expect(w.warn).toHaveBeenCalledTimes(1);
  });
});
