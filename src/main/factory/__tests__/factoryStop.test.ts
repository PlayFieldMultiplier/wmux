// The owner's stop of running bot work: turns interrupted, open bot tasks
// cancelled ("stopped by owner") without waking their bots, running gates
// cancelled, worker processes stopped; idempotent; the main window only.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import type { LedgerEntry } from '../../../shared/ledger';
import { installBotFanoutWake } from '../../deck/fanoutCallerNotify';
import { STOPPED_BY_OWNER, __resetFactoryStopForTesting, installLateStopSweep, isOpenBotTask, isWakeStoppedByOwner, stopFactoryWork, type FactoryStopPorts } from '../factoryStop';
import { factoryStopHandler } from '../../ipc/handlers/factory.handler';

const LEAD = 'bot-0000000a';
const TRIAGE = 'bot-0000000b';

let dir = '';
let ledger: TaskLedger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lifecycle-stop-'));
  ledger = new TaskLedger({ dir });
  __resetFactoryStopForTesting();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function task(id: string, botId: string | null, status = 'working'): Promise<void> {
  await ledger.register({
    id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-1', title: id,
    dispatch: { origin: botId ? { kind: 'bot', botId } : { kind: 'pane' }, preset: 'default' },
  });
  if (status === 'working') return;
  const row = ledger.get(id) as LedgerEntry;
  const actor = status === 'completed' ? { kind: 'brain' as const, workspaceId: 'ws-1' } : { kind: 'worker' as const, workspaceId: `${id}-ws` };
  if (status === 'completed') {
    await ledger.update({ id, status: 'review_requested', actor: { kind: 'worker', workspaceId: `${id}-ws` }, expectedRev: row.rev });
    const reported = ledger.get(id) as LedgerEntry;
    await ledger.recordGate(id, { exitCode: 0, tail: '', at: 1, command: 'npm test' }, { kind: 'system', workspaceId: 'ws-daemon' }, reported.rev);
    const gated = ledger.get(id) as LedgerEntry;
    const r = await ledger.update({ id, status, actor, expectedRev: gated.rev });
    if (!r.ok) throw new Error(r.message);
    return;
  }
  const r = await ledger.update({ id, status, actor, expectedRev: row.rev });
  if (!r.ok) throw new Error(r.message);
}

function ports(over: Partial<FactoryStopPorts> = {}) {
  const turns = new Set([LEAD]);
  const runtime = {
    currentTurn: vi.fn((botId: string) => (turns.has(botId) ? { wakeId: `w-${botId}` } : null)),
    interrupt: vi.fn((botId: string) => {
      turns.delete(botId);
      return { ok: true };
    }),
  };
  const gatesRunning = new Set(['t-gated']);
  const gates = {
    isRunning: vi.fn((id: string) => gatesRunning.has(id)),
    cancel: vi.fn((id: string) => gatesRunning.delete(id)),
  };
  // One session per task, gone after its first stop.
  const alive = new Set<string>();
  const stopWorker = vi.fn(async (entry: LedgerEntry): Promise<number> => {
    if (alive.has(entry.id)) return 0;
    alive.add(entry.id);
    return 1;
  });
  const p: FactoryStopPorts = {
    runtime: () => runtime,
    botIds: () => [LEAD, TRIAGE],
    ledger,
    gates: () => gates,
    stopWorker,
    log: () => undefined,
    ...over,
  };
  return { p, runtime, gates, stopWorker };
}

describe('stopFactoryWork', () => {
  it('interrupts running turns, cancels every open bot task as "stopped by owner", cancels its gate and stops its worker', async () => {
    await task('t-work', LEAD);
    await task('t-ask', TRIAGE, 'input_required');
    await task('t-gated', LEAD, 'review_requested');
    await task('t-human', null);
    await task('t-done', LEAD, 'completed');
    await task('t-failed', LEAD, 'failed');
    const r = ports();
    const res = await stopFactoryWork(r.p);
    expect(res).toEqual({ ok: true, botsInterrupted: 1, workersStopped: 3, gatesCancelled: 1 });
    expect(r.runtime.interrupt).toHaveBeenCalledWith(LEAD);
    // The stopped wake launches nothing more, before its turn has even ended.
    expect(isWakeStoppedByOwner(`w-${LEAD}`)).toBe(true);
    expect(isWakeStoppedByOwner(`w-${TRIAGE}`)).toBe(false);
    expect(r.runtime.interrupt).not.toHaveBeenCalledWith(TRIAGE); // no turn running
    for (const id of ['t-work', 't-ask', 't-gated']) {
      expect(ledger.get(id)).toMatchObject({ status: 'cancelled', summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system' } });
    }
    // Work that already ended, and work no bot started, is left alone.
    expect(ledger.get('t-human')?.status).toBe('working');
    expect(ledger.get('t-done')?.status).toBe('completed');
    expect(ledger.get('t-failed')?.status).toBe('failed');
    expect(r.stopWorker.mock.calls.map((c) => c[0].id).sort()).toEqual(['t-ask', 't-gated', 't-work']);
  });

  it('is idempotent: a second stop changes and counts nothing (it only checks the stopped worker is gone)', async () => {
    await task('t-work', LEAD);
    const r = ports();
    await stopFactoryWork(r.p);
    expect(await stopFactoryWork(r.p)).toEqual({ ok: true, botsInterrupted: 0, workersStopped: 0, gatesCancelled: 0 });
    expect(r.stopWorker).toHaveBeenCalledTimes(2);
  });

  it('a worker that could not be stopped is stopped by the next stop, and counted then', async () => {
    await task('t-work', LEAD);
    const r = ports();
    r.stopWorker.mockRejectedValueOnce(new Error('daemon gone'));
    const first = await stopFactoryWork(r.p);
    // The row is cancelled (the task is stopped), the stop reports it was partial.
    expect(first).toMatchObject({ ok: false, code: 'partial', workersStopped: 1 });
    expect(ledger.get('t-work')?.status).toBe('cancelled');
    expect(await stopFactoryWork(r.p)).toEqual({ ok: true, botsInterrupted: 0, workersStopped: 1, gatesCancelled: 0 });
  });

  it('a task the stopped bot\'s fan-out was still launching is stopped when it registers', async () => {
    let now = 1_000;
    const r = ports({ now: () => now });
    const off = installLateStopSweep({ ...r.p, onTransition: (fn) => ledger.onTransition(fn) });
    await stopFactoryWork(r.p, { botId: LEAD });
    await task('t-late', LEAD);
    await task('t-other', TRIAGE);
    await vi.waitFor(() => expect(ledger.get('t-late')?.status).toBe('cancelled'));
    expect(ledger.get('t-other')?.status).toBe('working');
    // Past the window a new task is the bot's own new work.
    now += 10 * 60_000;
    await task('t-next', LEAD);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.get('t-next')?.status).toBe('working');
    off();
  });

  it('one bot: only its turn and its tasks', async () => {
    await task('t-lead', LEAD);
    await task('t-triage', TRIAGE);
    const r = ports();
    expect(await stopFactoryWork(r.p, { botId: TRIAGE })).toEqual({ ok: true, botsInterrupted: 0, workersStopped: 1, gatesCancelled: 0 });
    expect(r.runtime.interrupt).not.toHaveBeenCalled();
    expect(ledger.get('t-lead')?.status).toBe('working');
    expect(ledger.get('t-triage')?.status).toBe('cancelled');
  });

  it('a worker that cannot be stopped, and no runtime or gate runner, still cancel the task', async () => {
    await task('t-work', LEAD);
    const r = ports({ runtime: () => null, gates: () => null, stopWorker: vi.fn(async (): Promise<number> => { throw new Error('daemon gone'); }) });
    expect(await stopFactoryWork(r.p)).toMatchObject({ ok: false, code: 'partial', botsInterrupted: 0, workersStopped: 1, gatesCancelled: 0 });
    expect(ledger.get('t-work')?.status).toBe('cancelled');
  });

  it('a task the owner stopped wakes no bot; another cancel still does, and worker-hours end either way', async () => {
    await task('t-stop', LEAD);
    await task('t-other', LEAD);
    const enqueue = vi.fn();
    const ended = vi.fn();
    const off = installBotFanoutWake({ enqueue, onWorkerEnded: ended }, ledger);
    await stopFactoryWork(ports({ ledger: { ...ledger, list: (f) => ledger.list(f).filter((e) => e.id === 't-stop'), get: (id) => ledger.get(id), update: (i) => ledger.update(i) } }).p);
    expect(enqueue).not.toHaveBeenCalled();
    const other = ledger.get('t-other') as LedgerEntry;
    await ledger.update({ id: 't-other', status: 'cancelled', actor: { kind: 'brain', workspaceId: 'ws-1' }, expectedRev: other.rev });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].reason.factIds).toEqual([`task.cancelled:t-other@${other.rev + 1}`]);
    expect(ended.mock.calls.map((c) => c[1]).sort()).toEqual(['t-other', 't-stop']);
    off();
  });

  it('a stop whose cancel did not land leaves the task\'s later cancel waking its bot', async () => {
    await task('t-1', LEAD);
    const enqueue = vi.fn();
    const off = installBotFanoutWake({ enqueue }, ledger);
    const refused = ports({ ledger: { list: (f) => ledger.list(f), get: (id) => ledger.get(id), update: async () => ({ ok: false, error: 'persist_failed', message: 'disk full' }) } });
    // The row could not be written; the worker is stopped all the same.
    expect(await stopFactoryWork(refused.p)).toMatchObject({ ok: false, code: 'partial', workersStopped: 1 });
    expect(refused.stopWorker).toHaveBeenCalledTimes(1);
    const row = ledger.get('t-1') as LedgerEntry;
    await ledger.update({ id: 't-1', status: 'cancelled', actor: { kind: 'brain', workspaceId: 'ws-1' }, expectedRev: row.rev });
    expect(enqueue).toHaveBeenCalledTimes(1);
    off();
  });

  it('a bot that stopped itself: a task it registers while that turn runs is stopped; after the turn, new work stands', async () => {
    const r = ports();
    const off = installLateStopSweep({ ...r.p, onTransition: (fn) => ledger.onTransition(fn) });
    await stopFactoryWork(r.p, { botId: LEAD, keepTurn: true });
    await task('t-same-turn', LEAD);
    await vi.waitFor(() => expect(ledger.get('t-same-turn')?.status).toBe('cancelled'));
    // The turn ended (no current turn): the owner may ask for work again at once.
    r.runtime.interrupt(LEAD);
    await task('t-after', LEAD);
    await new Promise((res) => setTimeout(res, 30));
    expect(ledger.get('t-after')?.status).toBe('working');
    off();
  });

  it('a bot stopping itself (keepTurn): its tasks stop and its wake launches nothing more, but its own turn runs on', async () => {
    await task('t-mine', LEAD);
    await task('t-other', TRIAGE);
    const r = ports();
    const res = await stopFactoryWork(r.p, { botId: LEAD, keepTurn: true });
    expect(res).toMatchObject({ ok: true, botsInterrupted: 0, workersStopped: 1 });
    expect(r.runtime.interrupt).not.toHaveBeenCalled();
    expect(isWakeStoppedByOwner(`w-${LEAD}`)).toBe(true);
    expect(ledger.get('t-mine')?.status).toBe('cancelled');
    expect(ledger.get('t-other')?.status).toBe('working');
  });

  it('pauses routines through its port: one bot\'s, or every bot\'s; a failing port makes the stop partial', async () => {
    const pauseRoutines = vi.fn((botId?: string) => (botId ? 1 : 3));
    const one = await stopFactoryWork(ports({ pauseRoutines }).p, { botId: TRIAGE });
    expect(one).toMatchObject({ ok: true, routinesPaused: 1 });
    expect(pauseRoutines).toHaveBeenLastCalledWith(TRIAGE);
    const all = await stopFactoryWork(ports({ pauseRoutines }).p);
    expect(all).toMatchObject({ ok: true, routinesPaused: 3 });
    expect(pauseRoutines).toHaveBeenLastCalledWith(undefined);
    const broken = await stopFactoryWork(ports({ pauseRoutines: () => { throw new Error('disk'); } }).p);
    expect(broken).toMatchObject({ ok: false, code: 'partial' });
    expect(broken.routinesPaused).toBeUndefined();
  });

  it('isOpenBotTask: open statuses of a bot task, optionally one bot', () => {
    const row = { status: 'working', dispatch: { origin: { kind: 'bot', botId: LEAD } } } as LedgerEntry;
    expect(isOpenBotTask(row)).toBe(true);
    expect(isOpenBotTask(row, TRIAGE)).toBe(false);
    expect(isOpenBotTask({ ...row, status: 'failed' })).toBe(false);
    expect(isOpenBotTask({ ...row, dispatch: { origin: { kind: 'pane' } } })).toBe(false);
  });
});

describe('a bot task report wakes from the system gate, not from the fan-out path', () => {
  it('a non-verify report wakes nothing here; its input_required and failed still do', async () => {
    await task('t-1', LEAD);
    const enqueue = vi.fn();
    const off = installBotFanoutWake({ enqueue }, ledger);
    const row = ledger.get('t-1') as LedgerEntry;
    await ledger.update({ id: 't-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 't-1-ws' }, expectedRev: row.rev });
    expect(enqueue).not.toHaveBeenCalled();
    const reported = ledger.get('t-1') as LedgerEntry;
    await ledger.update({ id: 't-1', status: 'failed', actor: { kind: 'worker', workspaceId: 't-1-ws' }, expectedRev: reported.rev });
    expect(enqueue.mock.calls.map((c) => c[0].reason.trigger.kind)).toEqual(['task.failed']);
    off();
  });
});

describe('factoryStopHandler (IPC guard)', () => {
  const mainFrame = { id: 'top' };
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents } as unknown as Electron.BrowserWindow;
  const NONE = { botsInterrupted: 0, workersStopped: 0, gatesCancelled: 0 };

  it('answers only the main window\'s top frame', async () => {
    await task('t-work', LEAD);
    const r = ports();
    const stopAll = factoryStopHandler(() => win, 'all', () => r.p);
    expect(await stopAll({ sender: {}, senderFrame: mainFrame })).toEqual({ ok: false, ...NONE, code: 'operator_only', message: 'only the main window may stop the bots' });
    expect(await stopAll({ sender: webContents, senderFrame: { id: 'sub' } })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await factoryStopHandler(() => null, 'all', () => r.p)({ sender: webContents, senderFrame: mainFrame })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(ledger.get('t-work')?.status).toBe('working');
    expect(await stopAll({ sender: webContents, senderFrame: mainFrame })).toEqual({ ok: true, botsInterrupted: 1, workersStopped: 1, gatesCancelled: 0 });
  });

  it('stop-bot needs a bot id; before the factory started there is nothing to stop', async () => {
    await task('t-work', TRIAGE);
    const r = ports();
    const stopBot = factoryStopHandler(() => win, 'bot', () => r.p);
    const ok = { sender: webContents, senderFrame: mainFrame };
    expect(await stopBot(ok, {})).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await stopBot(ok, { botId: '../x' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await factoryStopHandler(() => win, 'all', () => null)(ok)).toEqual({ ok: false, ...NONE, code: 'not_started', message: 'The factory is not running.' });
    expect(await stopBot(ok, { botId: TRIAGE })).toEqual({ ok: true, botsInterrupted: 0, workersStopped: 1, gatesCancelled: 0 });
  });
});

describe('stopFactoryWork and resumed workers', () => {
  it('stops the resumed workers of the bot (their tasks ended long ago) and counts them', async () => {
    const stopResumed = vi.fn(async (botId?: string) => (botId === TRIAGE ? 1 : 0));
    const r = ports({ stopResumed });
    expect(await stopFactoryWork(r.p, { botId: TRIAGE })).toMatchObject({ ok: true, workersStopped: 1 });
    expect(stopResumed).toHaveBeenCalledWith(TRIAGE);
    const failing = ports({ stopResumed: async () => { throw new Error('daemon gone'); } });
    expect(await stopFactoryWork(failing.p, {})).toMatchObject({ ok: false, code: 'partial' });
  });
});
