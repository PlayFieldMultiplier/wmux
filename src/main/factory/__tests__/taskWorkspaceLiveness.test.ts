import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import type { WorkspaceListEntry } from '../../../shared/workspaceMirror';
import { AGENT_GONE_FILENAME, AGENT_GONE_MAX, AgentGoneFacts, noteTaskPanesStopped, noteTaskWorkerLaunched, setAgentGoneFacts } from '../agentGoneFacts';
import { createTaskWorkspaceLiveness, parseSessionRead, type TaskWorkspaceLivenessPorts } from '../taskWorkspaceLiveness';
import type { ReclaimedWorker, WorkerSessionInfo } from '../workerReclaim';
import { FanOutGuards, refreshDormantTaskWorkspaces, setDormantRefresh, setDormantTaskWorkspaces } from '../../worktask/fanoutGuards';

const REFRESH_MS = 10_000;

type Task = { id: string; status: LedgerEntry['status']; pty: string };

const tmpDir = (): string => fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wmux-task-liveness-'));

/** A world of task workspaces (`tasks`, by workspace id), the mirror's view
 *  of them (null: not pushed yet), the daemon's sessions and whether it has
 *  finished restoring them, and the durable facts under `dir`. */
function world(tasks: Record<string, Task>, opts: { dir?: string; closed?: Record<string, Task> } = {}) {
  const t = { now: 1_000_000 };
  const dir = opts.dir ?? tmpDir();
  const closed = opts.closed ?? {};
  const state: {
    entries: WorkspaceListEntry[] | null;
    sessions: WorkerSessionInfo[] | 'down' | 'hang';
    recoveryDone: boolean;
    records: ReclaimedWorker[];
  } = { entries: null, sessions: [], recoveryDone: true, records: [] };
  const open = (): void => {
    state.entries = Object.entries(tasks).map(([ws, task]) => ({ id: ws, name: ws, ptyIds: [task.pty] }) as WorkspaceListEntry);
  };
  const reads = vi.fn();
  const rowOf = (ws: string, task: Task | undefined): LedgerEntry | null => (task ? ({ id: task.id, status: task.status, taskWorkspaceId: ws, updatedAt: t.now } as LedgerEntry) : null);
  const facts = new AgentGoneFacts(nodePath.join(dir, 'factory', AGENT_GONE_FILENAME), () => undefined);
  facts.load();
  const ports: TaskWorkspaceLivenessPorts = {
    entries: () => (state.entries ? [...state.entries] : null),
    readSessions: async () => {
      reads();
      if (state.sessions === 'down') throw new Error('the daemon is not connected');
      if (state.sessions === 'hang') return new Promise<never>(() => undefined);
      const answer = { sessions: state.sessions, recoveryDone: state.recoveryDone };
      // A daemon round-trip: answered on a later turn of the event loop.
      await new Promise((r) => setTimeout(r, 0));
      return answer;
    },
    workspaceRow: (ws) => rowOf(ws, tasks[ws] ?? closed[ws]),
    row: (taskId) => {
      const hit = Object.entries({ ...tasks, ...closed }).find(([, x]) => x.id === taskId);
      return hit ? rowOf(hit[0], hit[1]) : null;
    },
    endedRows: () => Object.entries(closed).map(([ws, x]) => rowOf(ws, x) as LedgerEntry),
    records: () => state.records,
    recordedSessions: () => [],
    sessionRecordOf: () => null,
    facts,
    refreshMs: REFRESH_MS,
    now: () => t.now,
  };
  const liveness = createTaskWorkspaceLiveness(ports);
  const guards = new FanOutGuards({
    dir: tmpDir(),
    now: () => t.now,
    openWorkspaceIds: () => Object.keys(tasks),
    ledgerTaskOwner: () => null,
  });
  for (const ws of Object.keys(tasks)) guards.markTask(ws, 'ws-owner');
  setDormantTaskWorkspaces(liveness.dormant);
  setDormantRefresh(liveness.refresh);
  return { t, dir, state, open, reads, facts, liveness, guards };
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
  });

  it('a task that ends after the last good read holds its slot while reads fail: nothing says its agent is gone', async () => {
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
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-x']);
    // The next good read sees it gone (after the read the check above set off).
    await w.liveness.refresh();
    w.state.sessions = [exited('p-x')];
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.guards.liveTaskWorkspaces()).toEqual([]);
  });

  it('a fresh read that never answers holds the check for 2 s at most, then the facts decide (second layer)', async () => {
    const dir = tmpDir();
    const first = world({ 'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' } }, { dir });
    first.open();
    first.state.sessions = [exited('p-done')];
    await first.liveness.refresh();
    await first.facts.written();
    const w = world({
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-run': { id: 't-run', status: 'working', pty: 'p-run' },
    }, { dir });
    w.open();
    w.state.sessions = 'hang';
    vi.useFakeTimers();
    let settled = false;
    void refreshDormantTaskWorkspaces().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-run']);
  });
});

describe('durable "agent seen gone" facts (#2393)', () => {
  it('a cold start whose daemon cannot answer counts an ended task seen gone before the restart as dormant, and one never seen gone as live', async () => {
    const dir = tmpDir();
    const tasks: Record<string, Task> = {
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-cancel': { id: 't-cancel', status: 'cancelled', pty: 'p-cancel' },
      'ws-held': { id: 't-held', status: 'completed', pty: 'p-held' },
    };
    const before = world(tasks, { dir });
    before.open();
    // Before the restart: two agents seen gone, one still running at shutdown.
    before.state.sessions = [exited('p-done'), exited('p-cancel'), running('p-held')];
    await before.liveness.refresh();
    await before.facts.written();

    const after = world(tasks, { dir });
    after.open();
    after.state.sessions = 'down';
    await refreshDormantTaskWorkspaces();
    expect(after.guards.liveTaskWorkspaces()).toEqual(['ws-held']);
    expect([...after.liveness.goneTasks()].sort()).toEqual(['t-cancel', 't-done']);
    expect(after.guards.reserve('k', 7)).toEqual({ ok: true });
  });

  it('a read while the daemon still restores its sessions writes nothing and keeps nothing; once it is done, an empty list frees the slots', async () => {
    const dir = tmpDir();
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'failed', pty: 'p-b' },
    }, { dir });
    w.open();
    // A WSL pane still waiting for its distribution reads as suspended.
    w.state.sessions = [{ id: 'p-a', state: 'suspended' } as WorkerSessionInfo];
    w.state.recoveryDone = false;
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-a', 'ws-b']);
    expect(w.facts.all()).toEqual([]);
    expect(w.liveness.goneTasks().size).toBe(0);
    // Not cached as fresh: the next check reads again.
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(2);

    // Recovery done, nothing came back: the agents are gone.
    w.state.sessions = [];
    w.state.recoveryDone = true;
    await w.liveness.refresh();
    expect(w.guards.liveTaskWorkspaces()).toEqual([]);
    await w.facts.written();
    expect(w.facts.all().map((f) => [f.taskId, f.taskWorkspaceId, f.sessions])).toEqual([['t-a', 'ws-a', ['p-a']], ['t-b', 'ws-b', ['p-b']]]);
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(dir, 'factory', AGENT_GONE_FILENAME), 'utf8')) as { version: number; facts: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.facts).toHaveLength(2);
  });

  it('a failed read never removes a fact; an agent seen running again clears it, for good', async () => {
    const dir = tmpDir();
    const tasks: Record<string, Task> = { 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } };
    const w = world(tasks, { dir });
    w.open();
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    expect(w.guards.liveTaskWorkspaces()).toEqual([]);
    // The owner started an agent in the ended task's pane (read after the
    // read the check above set off).
    await w.liveness.refresh();
    w.state.sessions = [running('p-x')];
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
    expect(w.guards.liveTaskWorkspaces()).toEqual(['ws-x']);
    await w.facts.written();
    // Running at the next shutdown: after the restart it holds its slot.
    const after = world(tasks, { dir });
    after.open();
    after.state.sessions = 'down';
    await refreshDormantTaskWorkspaces();
    expect(after.guards.liveTaskWorkspaces()).toEqual(['ws-x']);
  });

  it('a fact does not hold for a reopened row, a resumed worker, or a pane it does not name', async () => {
    const tasks: Record<string, Task> = {
      'ws-open': { id: 't-open', status: 'completed', pty: 'p-open' },
      'ws-resumed': { id: 't-resumed', status: 'completed', pty: 'p-resumed' },
      'ws-split': { id: 't-split', status: 'completed', pty: 'p-split' },
    };
    const w = world(tasks);
    w.open();
    w.state.sessions = [exited('p-open'), exited('p-resumed'), exited('p-split')];
    await w.liveness.refresh();
    expect(w.liveness.goneTasks().size).toBe(3);
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    tasks['ws-open'].status = 'working';
    w.state.records = [{ taskId: 't-resumed', state: 'resumed', taskWorkspaceId: 'ws-resumed', sessions: [] } as unknown as ReclaimedWorker];
    w.state.entries = (w.state.entries ?? []).map((e) => (e.id === 'ws-split' ? { ...e, ptyIds: ['p-split', 'p-new'] } : e));
    expect(w.guards.liveTaskWorkspaces().sort()).toEqual(['ws-open', 'ws-resumed', 'ws-split']);
    expect(w.liveness.goneTasks().size).toBe(0);
  });

  it('an ended task whose workspace is closed is recorded gone: its panes are gone', async () => {
    const w = world({ 'ws-open': { id: 't-open', status: 'working', pty: 'p-open' } }, {
      closed: { 'ws-closed': { id: 't-closed', status: 'completed', pty: 'p-closed' } },
    });
    w.open();
    w.state.sessions = [running('p-open')];
    await w.liveness.refresh();
    expect(w.facts.get('t-closed')).toMatchObject({ taskWorkspaceId: 'ws-closed', sessions: [] });
    expect([...w.liveness.goneTasks()]).toEqual(['t-closed']);
  });
});

describe('agent-gone facts file', () => {
  it('a file of another version, or one that cannot be read, means no facts and is never written over', async () => {
    const dir = tmpDir();
    const file = nodePath.join(dir, 'factory', AGENT_GONE_FILENAME);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const foreign = JSON.stringify({ version: 2, facts: [{ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: [], at: 1 }] });
    fs.writeFileSync(file, foreign);
    const warn = vi.fn();
    const facts = new AgentGoneFacts(file, warn);
    expect(() => facts.load()).not.toThrow();
    expect(facts.all()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    facts.note({ taskId: 't-b', taskWorkspaceId: 'ws-b', sessions: ['p-b'], at: 2 });
    await facts.written();
    expect(facts.get('t-b')).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(foreign);

    fs.writeFileSync(file, '{not json');
    const broken = new AgentGoneFacts(file, () => undefined);
    expect(() => broken.load()).not.toThrow();
    expect(broken.all()).toEqual([]);
  });

  it('a close that stopped the task\'s panes adds a fact; a new worker session for the task clears it', () => {
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined);
    facts.load();
    setAgentGoneFacts(facts);
    try {
      noteTaskPanesStopped('t-a', 'ws-a', ['p-a'], 5);
      expect(facts.get('t-a')).toEqual({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: 5 });
      noteTaskWorkerLaunched('t-a');
      expect(facts.get('t-a')).toBeNull();
    } finally {
      setAgentGoneFacts(null);
    }
  });

  it('keeps at most AGENT_GONE_MAX facts, the oldest dropped first', () => {
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined);
    facts.load();
    for (let i = 0; i <= AGENT_GONE_MAX; i++) facts.note({ taskId: `t-${i}`, taskWorkspaceId: `ws-${i}`, sessions: [], at: i });
    expect(facts.all()).toHaveLength(AGENT_GONE_MAX);
    expect(facts.get('t-0')).toBeNull();
    expect(facts.get(`t-${AGENT_GONE_MAX}`)).not.toBeNull();
  });
});

describe('parseSessionRead', () => {
  it('a bare list (an older daemon) is a recovered read; the flag is read when present; anything else fails', () => {
    expect(parseSessionRead([{ id: 'p' }])).toEqual({ sessions: [{ id: 'p' }], recoveryDone: true });
    expect(parseSessionRead({ sessions: [], recoveryDone: false })).toEqual({ sessions: [], recoveryDone: false });
    expect(parseSessionRead({ sessions: [] })).toEqual({ sessions: [], recoveryDone: true });
    expect(() => parseSessionRead(null)).toThrow();
    expect(() => parseSessionRead({ ok: false })).toThrow();
  });
});
