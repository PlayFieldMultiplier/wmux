// A bot worker whose task ended stops (its agent only, the pane stays) and
// can resume the same conversation; nothing else is ever reclaimed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  ReclaimedWorkers,
  createWorkerClear,
  installWorkerReclaim,
  isReclaimableEnd,
  isReclaimedSince,
  noteWorkerAgentExit,
  reclaimWorker,
  reclaimedSessionOf,
  reclaimedWorkerState,
  resumeLineFor,
  resumeWorker,
  resumedWorkersLive,
  setResumedLiveCount,
  stopResumedWorkers,
  unreclaimedEndedWorkers,
  RECLAIMED_WORKERS_MAX,
  type WorkerReclaimPorts,
  type WorkerResumePorts,
  type WorkerSessionInfo,
} from '../workerReclaim';
import { STOPPED_BY_OWNER } from '../factoryStop';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';

function row(status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: 1_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-reclaim-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(over: Partial<WorkerSessionInfo> = {}): WorkerSessionInfo {
  return { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' }, ...over };
}

function reclaimPorts(store: ReclaimedWorkers, sessions: WorkerSessionInfo[], over: Partial<WorkerReclaimPorts> = {}) {
  const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
  const note = vi.fn();
  let listener: ((t: { entry: LedgerEntry; from: string | null; to: string }) => void) | null = null;
  const ports: WorkerReclaimPorts = {
    onTransition: (fn) => { listener = fn; return () => { listener = null; }; },
    store,
    worktreeOf: async () => wt,
    listSessions: async () => sessions,
    stopAgent,
    note,
    now: () => 5_000,
    log: () => undefined,
    ...over,
  };
  return { ports, stopAgent, note, fire: (entry: LedgerEntry, to: string) => listener?.({ entry, from: 'review_requested', to }) };
}

describe('isReclaimableEnd', () => {
  it('only a bot task that completed, failed or was cancelled, never one the owner stopped', () => {
    expect(isReclaimableEnd(row('completed'), 'completed')).toBe(true);
    expect(isReclaimableEnd(row('cancelled'), 'cancelled')).toBe(true);
    expect(isReclaimableEnd(row('failed'), 'failed')).toBe(true);
    for (const open of ['working', 'input_required', 'review_requested']) expect(isReclaimableEnd(row('working'), open)).toBe(false);
    expect(isReclaimableEnd(row('completed', { dispatch: { origin: { kind: 'pane' } } }), 'completed')).toBe(false);
    expect(isReclaimableEnd(row('cancelled', { summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'ws-daemon' } }), 'cancelled')).toBe(false);
  });
});

describe('reclaimWorker', () => {
  it('stops the agent of every pane started in the worktree and records its conversation', async () => {
    const store = ReclaimedWorkers.at(dir);
    const other = session({ id: 'daemon-2', spawnCwd: path.join(dir, 'elsewhere') });
    const { ports, stopAgent, note } = reclaimPorts(store, [session(), other]);
    const rec = await reclaimWorker(ports, row('completed'), 'completed');
    expect(stopAgent).toHaveBeenCalledTimes(1);
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
    expect(rec?.sessions).toEqual([{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID, permissionMode: 'bypassPermissions' }]);
    expect(rec?.state).toBe('stopped');
    expect(reclaimedWorkerState(store.get(rec!.taskId))).toBe('resumable');
    expect(note.mock.calls[0][2]).toBe('Worker done (resumable)');
  });

  it('records nothing (and the worker keeps running) without a worktree or when every stop is refused; no pane left is recorded as nothing to stop', async () => {
    const store = ReclaimedWorkers.at(dir);
    expect(await reclaimWorker(reclaimPorts(store, [session()], { worktreeOf: async () => null }).ports, row('completed'), 'completed')).toBeNull();
    const none = ReclaimedWorkers.at(path.join(dir, 'none'));
    const empty = reclaimPorts(none, []);
    expect(await reclaimWorker(empty.ports, row('failed'), 'failed')).toMatchObject({ ended: 'failed', sessions: [] });
    expect(empty.stopAgent).not.toHaveBeenCalled();
    expect(reclaimedWorkerState(none.get('wtask-abc-12345678'))).toBe('stopped');
    const refused = reclaimPorts(store, [session()], { stopAgent: async () => ({ ok: false, code: 'unsupported' }) });
    expect(await reclaimWorker(refused.ports, row('completed'), 'completed')).toBeNull();
    expect(store.all()).toEqual([]);
  });

  it('persists the record across a reload', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('cancelled'), 'cancelled');
    const again = ReclaimedWorkers.at(dir);
    again.load();
    expect(again.get('wtask-abc-12345678')?.ended).toBe('cancelled');
  });
});

describe('installWorkerReclaim', () => {
  it('reclaims on completion, never on a move to an open status, and catches up on a recent end at install', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent, fire } = reclaimPorts(store, [session()], {
      allRows: () => [row('completed', { id: 'wtask-old-00000001', updatedAt: 4_000 }), row('completed', { id: 'wtask-ancient-0001', updatedAt: -1e9 })],
    });
    const off = installWorkerReclaim(ports);
    await vi.waitFor(() => expect(store.get('wtask-old-00000001')).not.toBeNull());
    expect(store.get('wtask-ancient-0001')).toBeNull();
    stopAgent.mockClear();
    fire(row('review_requested'), 'review_requested');
    fire(row('input_required'), 'input_required');
    fire(row('working'), 'working');
    await new Promise((r) => setTimeout(r, 10));
    expect(stopAgent).not.toHaveBeenCalled();
    fire(row('completed'), 'completed');
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1));
    off();
  });
});

describe('resumeWorker', () => {
  async function reclaimed(): Promise<ReclaimedWorkers> {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    return store;
  }
  function resumePorts(store: ReclaimedWorkers, live: WorkerSessionInfo[], over: Partial<WorkerResumePorts> = {}) {
    const typeLine = vi.fn(() => true);
    const ports: WorkerResumePorts = { store, listSessions: async () => live, typeLine, now: () => 9_000, ...over };
    return { ports, typeLine };
  }

  it('types the exact resume line into the recorded pane and marks the worker resumed', async () => {
    const store = await reclaimed();
    const { ports, typeLine } = resumePorts(store, [session({ agentProcessAlive: false })]);
    const r = await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'owner' });
    expect(r).toMatchObject({ ok: true, sessionId: 'daemon-1', resumeSessionId: UUID });
    expect(typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID} --dangerously-skip-permissions`);
    expect(store.get('wtask-abc-12345678')?.state).toBe('resumed');
    // Its agent exiting makes it resumable again.
    expect(noteWorkerAgentExit(store, 'daemon-1', 10_000)).toBe(true);
    expect(reclaimedWorkerState(store.get('wtask-abc-12345678'))).toBe('resumable');
  });

  it('refuses another bot, a closed or moved pane, a running agent, and a line the guard did not type', async () => {
    const store = await reclaimed();
    const dead = session({ agentProcessAlive: false });
    expect(await resumeWorker(resumePorts(store, [dead]).ports, 'wtask-abc-12345678', { kind: 'bot', botId: 'bot-0000000b' })).toMatchObject({ ok: false, code: 'not_yours' });
    expect(await resumeWorker(resumePorts(store, []).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'pane_gone' });
    expect(await resumeWorker(resumePorts(store, [{ ...dead, spawnCwd: dir }]).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'moved' });
    expect(await resumeWorker(resumePorts(store, [session()]).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
    const thrown = resumePorts(store, [dead], { typeLine: () => { throw new Error('guard refused'); } });
    expect(await resumeWorker(thrown.ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_typed' });
    expect(await resumeWorker(resumePorts(store, [dead]).ports, 'wtask-none-0000000', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_reclaimed' });
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
  });

  it('delivers a bot\'s message once the relaunched agent is up', async () => {
    const store = await reclaimed();
    let alive = false;
    const submit = vi.fn(async () => true);
    const { ports } = resumePorts(store, [session({ agentProcessAlive: false })], {
      agentAlive: async () => alive,
      submit,
      sleep: async () => { alive = true; },
    });
    const r = await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'bot', botId: BOT }, '  run npm test again  ');
    expect(r).toMatchObject({ ok: true, messageDelivered: true });
    expect(submit).toHaveBeenCalledWith('daemon-1', 'run npm test again');
  });

  it('a pane without a recorded conversation has no resume line', () => {
    expect(resumeLineFor({ sessionId: 'd', cwd: wt })).toBeNull();
    expect(resumeLineFor({ sessionId: 'd', cwd: wt, resumeSessionId: 'not-a-uuid' })).toBeNull();
    expect(resumeLineFor({ sessionId: 'd', cwd: wt, resumeSessionId: UUID })).toBe(`claude --resume ${UUID}`);
  });
});

describe('installWorkerReclaim retries', () => {
  it('an end the daemon could not serve yet is tried again, at most three times', async () => {
    vi.useFakeTimers();
    try {
      const store = ReclaimedWorkers.at(dir);
      let connected = false;
      const listSessions = vi.fn(async () => {
        if (!connected) throw new Error('the daemon is not connected');
        return [session()];
      });
      const { ports } = reclaimPorts(store, [], { listSessions, retryMs: 1_000, allRows: () => [row('completed', { updatedAt: 4_000 })] });
      const off = installWorkerReclaim(ports);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get('wtask-abc-12345678')).toBeNull();
      connected = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.get('wtask-abc-12345678')).not.toBeNull();
      off();

      const never = ReclaimedWorkers.at(path.join(dir, 'never'));
      const failing = vi.fn(async () => { throw new Error('down'); });
      const offNever = installWorkerReclaim(reclaimPorts(never, [], { listSessions: failing, retryMs: 1_000, allRows: () => [row('completed', { updatedAt: 4_000 })] }).ports);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failing).toHaveBeenCalledTimes(3);
      offNever();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resume safety (review fixes)', () => {
  async function reclaimedStore(): Promise<ReclaimedWorkers> {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    return store;
  }
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });
  const ports = (store: ReclaimedWorkers, live: WorkerSessionInfo[], over: Partial<WorkerResumePorts> = {}): WorkerResumePorts =>
    ({ store, listSessions: async () => live, typeLine: vi.fn(() => true), ...over });

  it('refuses a pane whose shell moved out of the task folder, or whose state cannot be told', async () => {
    const store = await reclaimedStore();
    expect(await resumeWorker(ports(store, [dead({ cwd: dir })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'moved' });
    expect(await resumeWorker(ports(store, [dead({ commandRunning: true })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
    expect(await resumeWorker(ports(store, [session({ agentProcessAlive: undefined })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'unknown_state' });
    // A shell at its prompt (OSC 133) with no agent ever seen is known idle.
    expect(await resumeWorker(ports(store, [session({ agentProcessAlive: undefined, commandRunning: false, cwd: wt })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
  });

  it('types once for two concurrent resumes and refuses a second resume of a resumed worker', async () => {
    const store = await reclaimedStore();
    const typeLine = vi.fn(() => true);
    const p = ports(store, [dead()], { typeLine });
    const [a, b] = await Promise.all([resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' }), resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(await resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
  });

  it('the owner\'s stop reaches a resumed worker; a launch slot hands over once the line is typed', async () => {
    const store = await reclaimedStore();
    const onLaunched = vi.fn();
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const p = ports(store, [dead()], { stopAgent });
    await resumeWorker(p, 'wtask-abc-12345678', { kind: 'bot', botId: BOT }, undefined, onLaunched);
    expect(onLaunched).toHaveBeenCalledTimes(1);
    expect(await stopResumedWorkers(p, 'bot-0000000b')).toEqual({ stopped: 0, failed: 0 });
    expect(await stopResumedWorkers(p, BOT)).toEqual({ stopped: 1, failed: 0 });
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
  });

  it('a record that cannot be written stops nothing', async () => {
    const store = ReclaimedWorkers.at(dir);
    vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk full'));
    const { ports: p, stopAgent } = reclaimPorts(store, [session()]);
    expect(await reclaimWorker(p, row('completed'), 'completed')).toBeNull();
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it('never evicts a resumed worker to stay under the record cap', async () => {
    const store = ReclaimedWorkers.at(dir);
    const rec = (i: number, state: 'stopped' | 'resumed') => ({ taskId: `wtask-n-${i}`, botId: BOT, ownerWorkspaceId: 'o', taskWorkspaceId: 't', title: 't', threadId: 'task:x' as never, ended: 'completed' as const, sessions: [], state, at: i });
    await store.put(rec(0, 'resumed'));
    for (let i = 1; i <= RECLAIMED_WORKERS_MAX; i++) await store.put(rec(i, 'stopped'));
    expect(store.get('wtask-n-0')).not.toBeNull();
    expect(store.get('wtask-n-1')).toBeNull();
    expect(store.all()).toHaveLength(RECLAIMED_WORKERS_MAX);
  });
});

describe('unreclaimedEndedWorkers', () => {
  it('counts an ended bot task (failed included) until its worker is reclaimed', async () => {
    const store = ReclaimedWorkers.at(dir);
    const rows = [row('failed', { id: 'wtask-f-00000001', updatedAt: 4_000 }), row('working', { id: 'wtask-w-00000001' }), row('completed', { id: 'wtask-c-00000001', updatedAt: 4_000 })];
    expect(unreclaimedEndedWorkers(rows, store, 5_000)).toBe(2);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, rows[0], 'failed');
    expect(store.get('wtask-f-00000001')?.ended).toBe('failed');
    expect(unreclaimedEndedWorkers(rows, store, 5_000)).toBe(1);
  });
});

describe('reclaim state and reopen (review fixes, PR #2164)', () => {
  const ID = 'wtask-abc-12345678';
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });

  it('a partly failed stop stays stopping (live, not resumable, counted) and a later look finishes it', async () => {
    const store = ReclaimedWorkers.at(dir);
    const two = [session(), session({ id: 'daemon-2' })];
    let refuse = true;
    const stopAgent = vi.fn(async (id: string) => (refuse && id === 'daemon-2' ? { ok: false, code: 'still_running' } : { ok: true, stopped: true }));
    const { ports, note } = reclaimPorts(store, two, { stopAgent });
    const rec = await reclaimWorker(ports, row('completed'), 'completed');
    expect(rec?.state).toBe('stopping');
    expect(note).not.toHaveBeenCalled();
    expect(reclaimedWorkerState(store.get(ID))).toBeNull();
    expect(unreclaimedEndedWorkers([row('completed', { updatedAt: 4_000 })], store, 5_000)).toBe(1);
    expect(await resumeWorker({ store, listSessions: async () => [dead()], typeLine: vi.fn(() => true) }, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'busy' });
    // The second look: a stopped agent no longer shows its binding; the
    // recorded conversation is kept.
    refuse = false;
    const again = reclaimPorts(store, [session({ resumeBinding: undefined }), session({ id: 'daemon-2', resumeBinding: undefined })], { stopAgent });
    const done = await reclaimWorker(again.ports, row('completed'), 'completed');
    expect(done?.state).toBe('stopped');
    expect(done?.sessions.find((s) => s.sessionId === 'daemon-1')?.resumeSessionId).toBe(UUID);
    expect(unreclaimedEndedWorkers([row('completed', { updatedAt: 4_000 })], store, 5_000)).toBe(0);
  });

  it('a task that reopened while the reclaim waited has nothing stopped and nothing recorded', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent } = reclaimPorts(store, [session()], { row: () => row('working', { rev: 4 }) });
    expect(await reclaimWorker(ports, row('failed'), 'failed')).toBeNull();
    expect(stopAgent).not.toHaveBeenCalled();
    expect(store.get(ID)).toBeNull();
  });

  it('a record covers only the end it was made for: a task that reopened and ended again is reclaimed again', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent, fire } = reclaimPorts(store, [session()]);
    const off = installWorkerReclaim(ports);
    fire(row('failed', { updatedAt: 1_000 }), 'failed');
    await vi.waitFor(() => expect(store.get(ID)?.state).toBe('stopped'));
    fire(row('failed', { updatedAt: 1_000 }), 'failed');
    await new Promise((r) => setTimeout(r, 10));
    expect(stopAgent).toHaveBeenCalledTimes(1);
    fire(row('completed', { rev: 7, updatedAt: 6_000 }), 'completed');
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(2));
    off();
  });

  it('a stop that ran while a resume was under way: the resume types nothing', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let release: () => void = () => undefined;
    const typeLine = vi.fn(() => true);
    const ports: WorkerResumePorts = {
      store,
      typeLine,
      stopAgent: vi.fn(async () => ({ ok: true, stopped: true })),
      listSessions: () => new Promise((resolve) => { release = () => resolve([dead()]); }),
    };
    const pending = resumeWorker(ports, ID, { kind: 'bot', botId: BOT });
    await new Promise((r) => setTimeout(r, 0));
    await stopResumedWorkers(ports, BOT);
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'not_now' });
    expect(typeLine).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe('stopped');
  });

  it('a pane that reopened after the stop ran has its agent stopped once it is up', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      stopAgent,
      listSessions: async () => [],
      folderExists: () => true,
      agentAlive: async () => true,
      respawn: async () => {
        await stopResumedWorkers(p, BOT);
        return { ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' };
      },
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_now' });
    expect(stopAgent).toHaveBeenCalledWith('daemon-9');
    expect(store.get(ID)?.state).toBe('stopped');
  });

  it('a resumed worker the stop could not stop is reported as failed and stays resumed', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const p: WorkerResumePorts = { store, typeLine: vi.fn(() => true), listSessions: async () => [dead()], stopAgent: vi.fn(async () => ({ ok: false, code: 'still_running' })) };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true });
    expect(await stopResumedWorkers(p)).toEqual({ stopped: 0, failed: 1 });
    expect(store.get(ID)?.state).toBe('resumed');
  });

  it('a bot\'s message from a wake that carried outside text goes only to a task started from outside text', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const base = { store, listSessions: async () => [dead()], typeLine: vi.fn(() => true) };
    const clean = { ...base, taskTainted: () => false, senderTainted: () => true };
    expect(await resumeWorker(clean, ID, { kind: 'bot', botId: BOT }, 'do it')).toMatchObject({ ok: false, code: 'not_now' });
    expect(base.typeLine).not.toHaveBeenCalled();
    // Unknown sender taint counts as outside text.
    expect(await resumeWorker({ ...base, taskTainted: () => false }, ID, { kind: 'bot', botId: BOT }, 'do it')).toMatchObject({ ok: false, code: 'not_now' });
    // The bot's worker budget applies to its resume.
    expect(await resumeWorker({ ...base, botWorkerRefusal: () => 'concurrent_workers' }, ID, { kind: 'bot', botId: BOT })).toMatchObject({ ok: false, code: 'not_now' });
    // Without a message there is no outside text to pass on.
    expect(await resumeWorker(clean, ID, { kind: 'bot', botId: BOT })).toMatchObject({ ok: true });
  });

  it('records no conversation that was started in another folder than the pane', () => {
    expect(reclaimedSessionOf(session({ resumeBinding: { agent: 'claude', sessionId: UUID, cwd: path.join(wt, 'sub') } }))?.resumeSessionId).toBeUndefined();
    expect(reclaimedSessionOf(session())?.resumeSessionId).toBe(UUID);
  });

  it('never closes the workspace of a task that reopened', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const closeWorkspace = vi.fn(async () => true);
    const clearPorts = {
      store,
      openWorkspaces: () => new Set(['ws-task']),
      viewedWorkspace: () => 'ws-other',
      workspacePtys: () => [],
      listSessions: async () => [],
      isTaskWorkspace: () => true,
      closeWorkspace,
    };
    expect(await createWorkerClear({ ...clearPorts, taskOpen: () => true }).reconcile()).toBe(0);
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(await createWorkerClear({ ...clearPorts, taskOpen: () => false }).reconcile()).toBe(1);
  });
});

describe('reclaim and resume races (review fixes, second pass)', () => {
  const ID = 'wtask-abc-12345678';
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });

  it('a task that reopens while the clear reads the sessions keeps its workspace', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let open = false;
    const closeWorkspace = vi.fn(async () => true);
    const clear = createWorkerClear({
      store,
      openWorkspaces: () => new Set(['ws-task']),
      viewedWorkspace: () => 'ws-other',
      workspacePtys: () => [],
      listSessions: async () => { open = true; return []; },
      isTaskWorkspace: () => true,
      taskOpen: () => open,
      closeWorkspace,
    });
    expect(await clear.reconcile()).toBe(0);
    expect(closeWorkspace).not.toHaveBeenCalled();
  });

  it('two resumes of one bot at once are both held to its worker budget', async () => {
    const a = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(a, [session()]).ports, row('completed'), 'completed');
    await reclaimWorker(reclaimPorts(a, [session({ id: 'daemon-2' })]).ports, row('completed', { id: 'wtask-def-12345678' }), 'completed');
    const releases: Array<() => void> = [];
    const ports: WorkerResumePorts = {
      store: a,
      typeLine: vi.fn(() => true),
      listSessions: () => new Promise((resolve) => { releases.push(() => resolve([dead(), dead({ id: 'daemon-2' })])); }),
      // A budget of one worker: the other resume under way counts.
      botWorkerRefusal: (_botId, starting) => (starting >= 1 ? 'concurrent_workers' : null),
    };
    const first = resumeWorker(ports, ID, { kind: 'bot', botId: BOT });
    const second = await resumeWorker(ports, 'wtask-def-12345678', { kind: 'bot', botId: BOT });
    expect(second).toMatchObject({ ok: false, code: 'not_now' });
    for (const r of releases) r();
    expect(await first).toMatchObject({ ok: true });
    // Once counted as resumed, the booking is gone.
    const third = await resumeWorker({ ...ports, listSessions: async () => [dead({ id: 'daemon-2' })] }, 'wtask-def-12345678', { kind: 'bot', botId: BOT });
    expect(third).toMatchObject({ ok: true });
  });

  it('a record covers the end it was made for by rev: a later end of the same task is not covered', async () => {
    const store = ReclaimedWorkers.at(dir);
    const rec = await reclaimWorker(reclaimPorts(store, [session()]).ports, row('failed', { rev: 3 }), 'failed');
    expect(rec?.endRev).toBe(3);
    expect(isReclaimedSince(store.get(ID), row('failed', { rev: 3, updatedAt: 99_999 }))).toBe(true);
    expect(isReclaimedSince(store.get(ID), row('failed', { rev: 5, updatedAt: 1 }))).toBe(false);
  });

  it('a relaunch the stop did not find running stays resumed (live) rather than stopped', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let t = 0;
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      stopAgent: vi.fn(async () => ({ ok: true, stopped: false })),
      listSessions: async () => [],
      folderExists: () => true,
      agentAlive: async () => false,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      agentWaitMs: 3_000,
      respawn: async () => {
        await stopResumedWorkers(p, BOT);
        return { ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' };
      },
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_now' });
    expect(store.get(ID)?.state).toBe('resumed');
  });

  it('a worker resumed in a new workspace owns its ledger row there', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    fs.mkdirSync(path.join(dir, 'ledger'));
    const ledger = new TaskLedger({ dir: path.join(dir, 'ledger') });
    await ledger.register({ id: ID, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A' });
    await ledger.update({ id: ID, status: 'failed', actor: { kind: 'system', workspaceId: 'daemon' }, expectedRev: 1 });
    const rebindTask = vi.fn(async (taskId: string, workspaceId: string) => {
      const r = await ledger.rebindTaskWorkspace({ id: taskId, taskWorkspaceId: workspaceId, actor: { kind: 'system', workspaceId: 'daemon' }, expectedRev: ledger.get(taskId)?.rev ?? 0 });
      return r.ok;
    });
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      listSessions: async () => [],
      folderExists: () => true,
      respawn: async () => ({ ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' }),
      rebindTask,
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true, workspaceId: 'ws-new' });
    expect(rebindTask).toHaveBeenCalledWith(ID, 'ws-new');
    expect(ledger.findByTaskWorkspace('ws-new')?.id).toBe(ID);
    const rev = ledger.get(ID)?.rev ?? 0;
    expect(await ledger.update({ id: ID, status: 'working', actor: { kind: 'worker', workspaceId: 'ws-new' }, expectedRev: rev })).toMatchObject({ ok: true });
  });

  it('the budget hears a resumed worker start and end, and the fan-out reads its live count', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const seen: string[] = [];
    store.onStateChange = (rec, from, to) => seen.push(`${rec.botId}:${rec.taskId}:${from}->${to}`);
    const p: WorkerResumePorts = { store, typeLine: vi.fn(() => true), listSessions: async () => [dead()] };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true });
    expect(noteWorkerAgentExit(store, 'daemon-1')).toBe(true);
    expect(seen).toEqual([`${BOT}:${ID}:stopped->resumed`, `${BOT}:${ID}:resumed->stopped`]);
    expect(resumedWorkersLive(BOT)).toBe(0);
    setResumedLiveCount((botId) => (botId === BOT ? 2 : 5));
    try {
      expect(resumedWorkersLive(BOT)).toBe(2);
      expect(resumedWorkersLive()).toBe(5);
    } finally {
      setResumedLiveCount(null);
    }
  });
});
