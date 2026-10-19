// A desktop restart loses the fan-out's in-memory launch confirmation; its
// daemon, task rows and recorded panes survive. Recovery never replays work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { installBotFanoutWake } from '../../deck/fanoutCallerNotify';
import { WorkerSlots } from '../workerSlots';
import { createWorkerLaunchRecovery, INTERRUPTED_WORKER_STARTUP } from '../workerLaunchRecovery';
import { WakeQueue } from '../wakeQueue';
import type { WorkerSessionInfo } from '../workerReclaim';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const taskId = 'wtask-interrupted';
const botId = 'bot-0000000a';
const ownerWorkspaceId = 'ws-owner';
const ptyId = 'pty-worker';

async function world(opts: { restart?: boolean; extraPane?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-startup-launch-')); dirs.push(dir);
  let ledger = new TaskLedger({ dir });
  let launches = WorkerSlots.at(dir, () => ledger.list()); launches.load();
  const req = { taskId, origin: 'bot' as const, botId, ownerWorkspaceId };
  const { gen } = launches.beginLaunch(req);
  launches.recordCreate({ taskId, gen }, 'ws-worker', ptyId);
  launches.launched(taskId, gen, 'ws-worker', ptyId);
  if (opts.extraPane) launches.recordCreate({ taskId, gen }, 'ws-worker', 'pty-second');
  launches.flushForTests();
  await ledger.register({ id: taskId, title: 'Interrupted startup', ownerWorkspaceId, taskWorkspaceId: 'ws-worker',
    dispatch: { origin: { kind: 'bot', botId, tainted: false }, threadId: 'general' } });
  await ledger.flush();
  if (opts.restart !== false) {
    ledger = new TaskLedger({ dir });
    launches = WorkerSlots.at(dir, () => ledger.list()); launches.load();
  }
  const state = { recoveryDone: true, sessions: [{ id: ptyId, agentProcessAlive: false, commandRunning: false }] as WorkerSessionInfo[],
    presence: 'absent' as 'running' | 'absent' | 'unknown', reason: 'idle-shell',
    incarnationId: 'incarnation-one', inputRevision: 0, outputBytes: 100, recoveredAgentUnconfirmed: false, down: false };
  const reading = (probeProcess = true) => ({ presence: probeProcess ? state.presence : 'unknown',
    reason: probeProcess ? state.reason : 'not-probed', incarnationId: state.incarnationId,
    inputRevision: state.inputRevision, outputBytes: state.outputBytes, recoveredAgentUnconfirmed: state.recoveredAgentUnconfirmed });
  const rpc = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (state.down) throw new Error('daemon unavailable');
    return method === 'daemon.listSessions' ? { recoveryDone: state.recoveryDone, sessions: state.sessions } : reading(params?.probeProcess === true);
  });
  const readSessions = vi.fn(() => rpc('daemon.listSessions'));
  const readPresence = vi.fn((id: string, probeProcess: boolean) => rpc('daemon.getLaunchPresence', { id, probeProcess }));
  const queue = new WakeQueue(path.join(dir, 'wake-queue.json'));
  const offWake = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, ledger);
  const changed = vi.fn();
  const recovery = createWorkerLaunchRecovery({ ledger, launches, readSessions, readPresence, changed });
  const dispose = async () => { recovery.dispose(); offWake(); launches.flushForTests(); await queue.flush(); await ledger.flush(); };
  return { dir, ledger, launches, req, gen, state, reading, rpc, readSessions, readPresence, queue, recovery, changed, dispose };
}

describe('interrupted fan-out startup recovery', () => {
  it('settles a surviving rev1 row only on a recovered daemon and fresh owned-pane absence; its bot wakes once across restart', async () => {
    const w = await world();
    expect(w.launches.launchOf(taskId)?.state).toBe('launched');
    expect(w.launches.beganInThisRun(taskId, w.gen)).toBe(false);
    expect(await w.recovery.pass()).toBe(1);
    expect(w.rpc).toHaveBeenCalledWith('daemon.getLaunchPresence', { id: ptyId, probeProcess: true });
    expect(w.ledger.get(taskId)).toMatchObject({ status: 'failed', rev: 2, summary: INTERRUPTED_WORKER_STARTUP });
    expect(w.queue.list({ states: ['queued'] })).toMatchObject([{ botId, workspaceId: ownerWorkspaceId,
      reason: { kind: 'facts', factIds: [`task.failed:${taskId}@2`], trigger: { kind: 'task.failed' } } }]);
    expect(await w.recovery.pass()).toBe(0);
    await w.queue.flush();
    await w.dispose();
    const againLedger = new TaskLedger({ dir: w.dir });
    const againQueue = new WakeQueue(path.join(w.dir, 'wake-queue.json')); againQueue.load();
    const off = installBotFanoutWake({ enqueue: (input) => againQueue.enqueue(input),
      wakeKnown: (_bot, factId) => againQueue.list().some((wake) => wake.state !== 'dropped' && wake.reason.kind === 'facts' && wake.reason.factIds.includes(factId)),
    }, againLedger);
    expect(againLedger.get(taskId)?.status).toBe('failed');
    expect(againQueue.list()).toHaveLength(1);
    off();
  });

  it('does not inspect a fresh launch that began in this desktop process', async () => {
    const w = await world({ restart: false });
    expect(w.launches.beganInThisRun(taskId, w.gen)).toBe(true);
    expect(await w.recovery.pass()).toBe(0);
    expect(w.readSessions).not.toHaveBeenCalled();
    expect(w.ledger.get(taskId)?.status).toBe('working');
    await w.dispose();
  });

  it('leaves a cold-respawned shell to Resume even with the same incarnation and a reset zero input counter', async () => {
    const w = await world();
    w.state.sessions[0].recoveredAgentUnconfirmed = true;
    expect(w.state.inputRevision).toBe(0);
    expect(await w.recovery.pass()).toBe(0);
    expect(w.readPresence).not.toHaveBeenCalled();
    expect(w.ledger.get(taskId)).toMatchObject({ status: 'working', rev: 1 });
    expect(w.queue.list()).toHaveLength(0);
    await w.dispose();
  });

  it.each(['before process read', 'before final witness'])('keeps a cold restart unknown when it occurs after the session list, %s', async (timing) => {
    const w = await world();
    const original = w.readPresence.getMockImplementation();
    if (!original) throw new Error('presence reader is missing');
    w.readPresence.mockImplementationOnce(async (id, probeProcess) => {
      if (timing === 'before process read') w.state.recoveredAgentUnconfirmed = true;
      const before = await original(id, probeProcess);
      w.state.recoveredAgentUnconfirmed = true;
      return before;
    });
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)).toMatchObject({ status: 'working', rev: 1 });
    expect(w.queue.list()).toHaveLength(0);
    await w.dispose();
  });

  it.each(['foreign bot', 'foreign owner', 'owner launch', 'released launch'])('requires matching durable ownership and an open launch: %s', async (mismatch) => {
    const w = await world();
    const launch = w.launches.launchOf(taskId);
    if (!launch) throw new Error('persisted launch is missing');
    if (mismatch === 'foreign bot') launch.botId = 'bot-other';
    else if (mismatch === 'foreign owner') launch.ownerWorkspaceId = 'ws-other';
    else if (mismatch === 'owner launch') launch.origin = 'owner';
    else launch.state = 'released';
    const recovery = createWorkerLaunchRecovery({ ledger: w.ledger, launches: {
      launchOf: () => launch, panesOf: (id, gen) => w.launches.panesOf(id, gen), beganInThisRun: () => false, leaseRecovery: () => null,
    }, readSessions: w.readSessions, readPresence: w.readPresence });
    expect(await recovery.pass()).toBe(0);
    expect(w.readSessions).not.toHaveBeenCalled();
    expect(w.ledger.get(taskId)?.status).toBe('working');
    recovery.dispose(); await w.dispose();
  });

  it.each(['restoring', 'old daemon', 'missing flag', 'read error'])('keeps the row while startup session evidence is %s, then retries', async (failure) => {
    const w = await world();
    if (failure === 'restoring') w.state.recoveryDone = false;
    else if (failure === 'read error') w.state.down = true;
    else w.readSessions.mockResolvedValueOnce(failure === 'old daemon' ? w.state.sessions : { sessions: w.state.sessions });
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    expect(w.rpc.mock.calls.every(([method]) => method !== 'daemon.getLaunchPresence')).toBe(true);
    w.state.recoveryDone = true; w.state.down = false;
    expect(await w.recovery.pass()).toBe(1);
    await w.dispose();
  });

  it.each(['live agent', 'foreground command', 'exec pane', 'probe running', 'probe unknown', 'probe error', 'missing pane'])('cannot fail on %s evidence', async (evidence) => {
    const w = await world();
    if (evidence === 'live agent') w.state.sessions[0].agentProcessAlive = true;
    else if (evidence === 'foreground command') w.state.sessions[0].commandRunning = true;
    else if (evidence === 'exec pane') w.state.sessions[0].exec = { command: 'claude' };
    else if (evidence === 'missing pane') w.state.sessions = [];
    else if (evidence === 'probe running') w.state.presence = 'running';
    else if (evidence === 'probe unknown') w.state.presence = 'unknown';
    else w.readPresence.mockRejectedValue(new Error('process probe unavailable'));
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    expect(w.queue.list()).toHaveLength(0);
    await w.dispose();
  });

  it('leaves multiple recorded panes unknown, so an early absence cannot outlive a later pane probe', async () => {
    const w = await world({ extraPane: true });
    // A missing second recorded pane is unknown even though the first is idle.
    expect(await w.recovery.pass()).toBe(0);
    w.state.sessions.push({ id: 'pty-second', commandRunning: false, agentProcessAlive: false });
    expect(await w.recovery.pass()).toBe(0);
    expect(w.readPresence).not.toHaveBeenCalled();
    expect(w.ledger.get(taskId)?.status).toBe('working');
    await w.dispose();
  });

  it.each(['wsl-line-never-read', 'wsl-launch-failed', 'missing witness', 'missing recovery flag'])('does not fail on unsupported process evidence: %s', async (reason) => {
    const w = await world();
    if (reason === 'missing witness') w.readPresence.mockResolvedValueOnce({ presence: 'absent', reason: 'idle-shell', incarnationId: 'old-daemon' });
    else if (reason === 'missing recovery flag') w.readPresence.mockResolvedValueOnce({ presence: 'absent', reason: 'idle-shell', incarnationId: 'old-daemon', inputRevision: 0, outputBytes: 100 });
    else w.state.reason = reason;
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    await w.dispose();
  });

  it('keeps an already-delivered line unknown: shell startup may still execute it after the idle-shell read', async () => {
    const w = await world();
    w.state.inputRevision = 1;
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    expect(w.queue.list()).toHaveLength(0);
    await w.dispose();
  });

  it.each(['input', 'output', 'incarnation', 'agent'])('rechecks the final pane witness before idle-only ledger admission after %s changes', async (change) => {
    const w = await world();
    const original = w.readPresence.getMockImplementation();
    if (!original) throw new Error('presence reader is missing');
    w.readPresence.mockImplementationOnce(async (id, probeProcess) => {
      const before = await original(id, probeProcess);
      if (change === 'input') w.state.inputRevision++;
      else if (change === 'output') w.state.outputBytes++;
      else if (change === 'incarnation') w.state.incarnationId = 'incarnation-two';
      else w.readPresence.mockResolvedValueOnce({ ...w.reading(false), presence: 'running', reason: 'agent-named' });
      return before;
    });
    expect(await w.recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    await w.dispose();
  });

  it('does not block an unrelated ledger append while the final daemon witness is pending', async () => {
    const w = await world();
    let finishWitness!: (value: unknown) => void;
    const original = w.readPresence.getMockImplementation();
    if (!original) throw new Error('presence reader is missing');
    w.readPresence.mockImplementation((id, probeProcess) => probeProcess ? original(id, true)
      : new Promise<unknown>((resolve) => { finishWitness = resolve; }));
    const pass = w.recovery.pass();
    try {
      await vi.waitFor(() => expect(w.readPresence).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      let appended = false;
      const unrelated = w.ledger.recordOrphanedEvent({ ownerWorkspaceId, seq: 1, payload: {} }).then(() => { appended = true; });
      await vi.waitFor(() => expect(appended).toBe(true), { timeout: 5_000 });
      finishWitness(w.reading(false));
      expect(await pass).toBe(1);
      await unrelated;
    } finally { finishWitness?.(w.reading(false)); await pass; await w.dispose(); }
  });

  it.each(['success', 'error'])('skips a busy ledger instead of queuing old proof, and retries after the preceding append ends with %s', async (outcome) => {
    const w = await world();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered = false;
    const append = fs.promises.appendFile;
    const spy = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (file, data, options) => {
      if (String(data).includes('"op":"orphaned_event"')) {
        entered = true; await blocked;
        if (outcome === 'error') throw new Error('unrelated append failed');
      }
      return append(file, data, options);
    });
    try {
      const earlier = w.ledger.recordOrphanedEvent({ ownerWorkspaceId, seq: 1, payload: {} }).catch(() => undefined);
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
      expect(await w.recovery.pass()).toBe(0);
      expect(w.ledger.get(taskId)?.status).toBe('working');
      expect(w.readPresence).toHaveBeenCalledTimes(2);
      unblock(); await earlier;
      spy.mockRestore();
      expect(await w.recovery.pass()).toBe(1);
      expect(w.readPresence).toHaveBeenCalledTimes(4);
    } finally { unblock(); spy.mockRestore(); await w.dispose(); }
  });

  it('never applies proof skipped during a busy append to a newer launch generation', async () => {
    const w = await world();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const append = fs.promises.appendFile;
    const spy = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (file, data, options) => {
      if (String(data).includes('"op":"orphaned_event"')) await blocked;
      return append(file, data, options);
    });
    try {
      const earlier = w.ledger.recordOrphanedEvent({ ownerWorkspaceId, seq: 1, payload: {} });
      const pass = w.recovery.pass();
      await vi.waitFor(() => expect(w.readPresence).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      w.launches.beginLaunch(w.req);
      unblock(); await earlier;
      expect(await pass).toBe(0);
      expect(w.ledger.get(taskId)?.status).toBe('working');
    } finally { unblock(); spy.mockRestore(); await w.dispose(); }
  });

  it.each(['finish', 'dispose', 'append error'])('leases the generation through an in-flight append and releases it after %s', async (outcome) => {
    const w = await world();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered = false;
    const append = fs.promises.appendFile;
    const spy = vi.spyOn(fs.promises, 'appendFile').mockImplementation(async (file, data, options) => {
      if (String(data).includes('"status":"failed"')) {
        entered = true; await blocked;
        if (outcome === 'append error') throw new Error('disk full');
      }
      return append(file, data, options);
    });
    try {
      const pass = w.recovery.pass();
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
      expect(() => w.launches.beginLaunch(w.req)).toThrow('retry once it finishes');
      expect(w.launches.launchOf(taskId)?.gen).toBe(w.gen);
      if (outcome === 'dispose') w.recovery.dispose();
      unblock();
      expect(await pass).toBe(outcome === 'append error' ? 0 : 1);
      expect(w.launches.beginLaunch(w.req).gen).toBe(w.gen + 1);
      expect(w.ledger.get(taskId)?.status).toBe(outcome === 'append error' ? 'working' : 'failed');
    } finally { unblock(); spy.mockRestore(); await w.dispose(); }
  });

  it('ignores unrelated workspace panes and a stale generation whose original pane remains', async () => {
    const w = await world();
    w.launches.beginLaunch(w.req);
    w.launches.flushForTests();
    const loaded = WorkerSlots.at(w.dir, () => w.ledger.list()); loaded.load();
    w.state.sessions.push({ id: 'unrelated-idle-pane', agentProcessAlive: false, commandRunning: false });
    const recovery = createWorkerLaunchRecovery({ ledger: w.ledger, launches: loaded, readSessions: w.readSessions, readPresence: w.readPresence });
    expect(await recovery.pass()).toBe(0);
    expect(w.ledger.get(taskId)?.status).toBe('working');
    expect(w.rpc.mock.calls.every(([method]) => method !== 'daemon.getLaunchPresence')).toBe(true);
    recovery.dispose(); await w.dispose();
  });

  it.each(['report', 'owner stop', 'new generation', 'new pane', 'dispose'])('rechecks ownership, revision and generation after the probe when interrupted by %s', async (change) => {
    const w = await world();
    let resolve!: (presence: unknown) => void;
    w.readPresence.mockImplementationOnce(() => new Promise<unknown>((r) => { resolve = r; }));
    const pass = w.recovery.pass();
    await vi.waitFor(() => expect(w.readPresence).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    if (change === 'new generation') w.launches.beginLaunch(w.req);
    else if (change === 'new pane') w.launches.recordCreate({ taskId, gen: w.gen }, 'ws-moved', 'pty-new');
    else if (change === 'dispose') w.recovery.dispose();
    else await w.ledger.update({ id: taskId, status: change === 'report' ? 'review_requested' : 'cancelled', expectedRev: 1,
      actor: change === 'report' ? { kind: 'worker', workspaceId: 'ws-worker' } : { kind: 'system', workspaceId: ownerWorkspaceId } });
    resolve(w.reading());
    expect(await pass).toBe(0);
    expect(w.ledger.get(taskId)?.status).not.toBe('failed');
    await w.dispose();
  });
});
