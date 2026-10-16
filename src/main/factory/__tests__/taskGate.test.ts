// The system gate on a bot task's report: main gates every non-verify bot
// task that reports review_requested, completes it on a pass (as its owner,
// unforced: the ledger itself checks the system gate), leaves it open
// otherwise, and wakes the bot that started it once either way.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { LedgerEntry, LedgerGateResult } from '../../../shared/ledger';
import type { GateRunInput, GateRunResult } from '../../worktask/TaskGateRunner';
import { completeCheckedTask, completeMergedTask, completeResearchTask, describeTaskGate, gateCardNoted, installTaskGate, isMergeCompletion, isTaskGateReport, mergedMark, mergesOfBranch, reportWasGated, worktreeHeadMerged, type TaskGatePorts } from '../taskGate';
import { factDedupeKey, type Fact } from '../../../shared/facts';
import type { RoomCard } from '../../../shared/room';
import { RoomWriter } from '../roomWriter';
import { verifyGateFactId } from '../verifyPreset';
import { countOpenBotWorkers } from '../../pipe/handlers/fanout.rpc';

const BOT = 'bot-0000000a';
const HEAD = 'c'.repeat(40);

const lead: BotProfile = {
  version: 1, id: BOT, workspaceId: 'ws-lead', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { ...DEFAULT_BOT_BUDGETS.lead }, repo: { repoKey: 'github.com/acme/app', repoPath: '/repo' }, enabled: true, createdAt: 1, updatedAt: 1,
};

let dir = '';
let ledger: TaskLedger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lifecycle-gate-'));
  ledger = new TaskLedger({ dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let the gate's ledger writes (file appends) and wakes land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 5));
};

async function register(id = 'task-1', preset = 'default', origin: { kind: string; botId?: string } = { kind: 'bot', botId: BOT }): Promise<void> {
  await ledger.register({ id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-lead', title: `task ${id}`, dispatch: { origin, preset } });
}

async function report(id = 'task-1', status = 'review_requested'): Promise<LedgerEntry> {
  const row = ledger.get(id) as LedgerEntry;
  const r = await ledger.update({ id, status, actor: { kind: 'worker', workspaceId: `${id}-ws` }, expectedRev: row.rev, summary: 'done' });
  if (!r.ok) throw new Error(r.message);
  return r.entry;
}

const PASS: LedgerGateResult = { exitCode: 0, tail: 'ok', at: 5, command: 'npm run lint', headSha: HEAD };

/** A runner that records `gate` the way TaskGateRunner does (null: records nothing). */
function recordingRunner(gate: LedgerGateResult | null, result?: (input: GateRunInput) => GateRunResult) {
  return vi.fn(async (input: GateRunInput): Promise<GateRunResult> => {
    let recorded = false;
    if (gate) {
      const row = ledger.get(input.taskId);
      if (row) recorded = (await ledger.recordGate(input.taskId, gate, { kind: 'system', workspaceId: input.systemWorkspaceId }, row.rev)).ok;
    }
    if (result) return result(input);
    return gate?.skipped
      ? { ok: true, status: 'skipped', taskId: input.taskId, skipped: 'no_gate_command', detail: 'no gate declared', recorded }
      : { ok: true, status: 'completed', taskId: input.taskId, result: { ...(gate as LedgerGateResult), recordedBy: 'system' }, recorded };
  });
}

function rig(over: Partial<TaskGatePorts> = {}, runGate: ReturnType<typeof vi.fn<TaskGatePorts['runGate']>> = recordingRunner(PASS)) {
  const wake = vi.fn();
  const note = vi.fn();
  const off = installTaskGate({
    onTransition: (fn) => ledger.onTransition(fn),
    ledgerRow: (id) => ledger.get(id),
    openRows: () => ledger.list({ openOnly: true }),
    bot: (id) => (id === BOT ? lead : null),
    worktreeOf: async () => '/wt/task',
    baseRef: async () => 'origin/main',
    runGate,
    complete: (id) => completeCheckedTask(ledger, id),
    completeResearch: (id) => completeResearchTask(ledger, id),
    wake,
    note,
    ...over,
  });
  return { wake, note, off, runGate };
}

describe('the system gate on a bot task report', () => {
  it('pass: gates with the base branch\'s gate, completes the task as its owner (unforced), one card and one wake', async () => {
    await register();
    const r = rig();
    await report();
    await flush();
    expect(r.runGate).toHaveBeenCalledTimes(1);
    expect(r.runGate).toHaveBeenCalledWith({ taskId: 'task-1', worktreePath: '/wt/task', systemWorkspaceId: 'ws-daemon', projectRoot: '/repo', gateBaseRef: 'origin/main' });
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(row.summary).toBe('done'); // no [forced: …]
    expect(r.note).toHaveBeenCalledTimes(1);
    expect(r.note.mock.calls[0][2]).toBe('Task checked: gate passed, task completed');
    // A completed task holds no worker slot.
    expect(countOpenBotWorkers(ledger.list({ openOnly: true }), BOT, () => new Set())).toEqual({ bot: 0, factory: 0 });
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake).toHaveBeenCalledWith({
      botId: BOT, workspaceId: 'ws-lead', priority: 1, threadId: 'task:task-1',
      reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', row.rev)], trigger: { kind: 'task.done' } },
    });
  });

  it('fail: the task stays open (review_requested), a card with the exit code, one wake', async () => {
    await register();
    const r = rig({}, recordingRunner({ ...PASS, exitCode: 1 }));
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('review_requested');
    expect(row.gate?.exitCode).toBe(1);
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate failed (exit 1): task left open']);
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('skipped: a recorded "no gate declared" is not a check; an unrecorded skip and a refusal leave it open too', async () => {
    await register('a');
    await register('b');
    await register('c');
    const runs: Record<string, TaskGatePorts['runGate']> = {
      a: recordingRunner({ ...PASS, command: 'none', skipped: 'no_gate_command' }),
      b: recordingRunner(null, (i) => ({ ok: true, status: 'skipped', taskId: i.taskId, skipped: 'deps_missing', detail: 'node_modules is missing' })),
      c: recordingRunner(null, (i) => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'the worktree scripts differ from the base' })),
    };
    const r = rig({}, vi.fn((input: GateRunInput) => runs[input.taskId](input)));
    await report('a');
    await report('b');
    await report('c');
    await flush();
    for (const id of ['a', 'b', 'c']) expect(ledger.get(id)?.status).toBe('review_requested');
    expect(r.note.mock.calls.map((c) => c[2]).sort()).toEqual([
      'Gate refused: task left open',
      'Gate skipped (deps_missing): task left open',
      'Gate skipped (no_gate_command): task left open',
    ]);
    expect(r.wake).toHaveBeenCalledTimes(3);
  });

  it('no worktree or no base branch: nothing runs, the task stays open, one wake', async () => {
    await register();
    const r = rig({ baseRef: async () => null });
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.note.mock.calls[0][2]).toBe('Gate not run: task left open');
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('only non-verify bot tasks reporting review_requested', async () => {
    await register('v', 'verify');
    await register('p', 'default', { kind: 'pane' });
    await register('w');
    const r = rig();
    await report('v');
    await report('p');
    await report('w', 'input_required');
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
    expect(isTaskGateReport(ledger.get('v') as LedgerEntry, 'review_requested')).toBe(false);
  });

  it('double report: a same-status resubmit is no second gate; a report that lands while the gate runs is gated again and only that run settles it', async () => {
    await register();
    let release: (() => void) | null = null;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const pass = recordingRunner(PASS);
    const runGate = vi.fn(async (input: GateRunInput) => {
      calls++;
      if (calls === 1) await first;
      return pass(input);
    });
    const r = rig({}, runGate);
    await report();
    await flush();
    // Same status again: a no-op in the ledger, no transition.
    const row = ledger.get('task-1') as LedgerEntry;
    const again = await ledger.update({ id: 'task-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'task-1-ws' }, expectedRev: row.rev });
    expect(again.ok && again.noop).toBe(true);
    // Sent back and reported again while the first gate still runs.
    const back = await ledger.update({ id: 'task-1', status: 'input_required', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev });
    if (!back.ok) throw new Error(back.message);
    await report();
    (release as unknown as () => void)();
    await flush();
    expect(runGate).toHaveBeenCalledTimes(2);
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.note).toHaveBeenCalledTimes(1);
  });

  it('a task that moved while its gate ran (cancelled, sent back) gets no card, no wake and is not completed', async () => {
    await register();
    const runGate = vi.fn(async (input: GateRunInput): Promise<GateRunResult> => {
      const row = ledger.get(input.taskId) as LedgerEntry;
      await ledger.update({ id: input.taskId, status: 'cancelled', actor: { kind: 'system', workspaceId: 'ws-daemon' }, expectedRev: row.rev, summary: 'stopped by owner' });
      return { ok: true, status: 'completed', taskId: input.taskId, recorded: true, result: { ...PASS, exitCode: null } };
    });
    const r = rig({}, runGate);
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('cancelled');
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('restart: a report with no gate after it, or with a recorded pass (it may be an older report\'s), is gated at install; a recorded fail wakes again without a second card', async () => {
    await register('ungated');
    await report('ungated');
    await register('passed');
    await report('passed');
    await ledger.recordGate('passed', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await register('failed');
    await report('failed');
    await ledger.recordGate('failed', { ...PASS, exitCode: 2 }, { kind: 'system', workspaceId: 'ws-daemon' });
    // A gate recorded BEFORE the report is not this report's gate.
    await register('stale');
    await ledger.recordGate('stale', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await report('stale');

    const r = rig();
    await flush();
    expect(r.runGate.mock.calls.map((c) => c[0].taskId).sort()).toEqual(['passed', 'stale', 'ungated']);
    expect(ledger.get('passed')?.status).toBe('completed');
    expect(ledger.get('ungated')?.status).toBe('completed');
    expect(ledger.get('failed')?.status).toBe('review_requested');
    const failedRev = (ledger.get('failed') as LedgerEntry).rev;
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0])).toContain(verifyGateFactId('failed', failedRev));
    expect(r.note.mock.calls.filter((c) => String(c[2]).startsWith('Gate failed'))).toHaveLength(0);
    // One wake per task: the queue dedupes a second install's identical ids.
    expect(r.wake).toHaveBeenCalledTimes(4);
  });

  it('restart: a refused report whose rev was already carded is not gated or carded again, only woken; one that was not carded is gated', async () => {
    const refuse = recordingRunner(null, (i) => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'the worktree scripts differ from the base' }));
    await register('carded');
    await register('uncarded');
    // Before the restart: both reports were refused, and one card each was written.
    const cards = new Set<string>();
    const first = rig({ note: (_ws, _t, _title, _body, key) => { cards.add(key); } }, refuse);
    await report('carded');
    await flush();
    first.off();
    expect(cards).toEqual(new Set([verifyGateFactId('carded', (ledger.get('carded') as LedgerEntry).rev)]));
    await report('uncarded');

    const r = rig({ noted: (_ws, _t, key) => cards.has(key) }, refuse);
    await flush();
    expect(refuse.mock.calls.map((c) => c[0].taskId)).toEqual(['carded', 'uncarded']); // 'carded' only before the restart
    expect(r.note.mock.calls.map((c) => c[4])).toEqual([verifyGateFactId('uncarded', (ledger.get('uncarded') as LedgerEntry).rev)]);
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0]).sort()).toEqual([
      verifyGateFactId('carded', (ledger.get('carded') as LedgerEntry).rev),
      verifyGateFactId('uncarded', (ledger.get('uncarded') as LedgerEntry).rev),
    ].sort());
    expect(ledger.get('carded')?.status).toBe('review_requested');
  });

  it('restart: a carded pass whose completion did not land is gated again, not only woken', async () => {
    await register('passed');
    await report('passed');
    await ledger.recordGate('passed', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    const r = rig({ noted: () => true });
    await flush();
    expect(r.runGate.mock.calls.map((c) => c[0].taskId)).toEqual(['passed']);
    expect(ledger.get('passed')?.status).toBe('completed');
  });

  it('restart: the catch-up waits while the room cannot be read, and runs as before when it never can', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await register();
      await report();
      let readable = false;
      const r = rig({ noted: () => (readable ? true : null), notedWaitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(500);
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.wake).not.toHaveBeenCalled();
      readable = true;
      await vi.advanceTimersByTimeAsync(300);
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.wake).toHaveBeenCalledTimes(1);
      r.off();

      const never = rig({ noted: () => null, notedWaitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(never.runGate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a gate card\'s key survives a restart of the room (written, then read back from disk)', () => {
    const rooms = path.join(dir, 'rooms');
    const key = verifyGateFactId('wtask-a1b2c3d4-0123456789abcdef', 123456);
    const thread = 'task:wtask-a1b2c3d4-0123456789abcdef' as RoomCard['threadId'];
    const before = new RoomWriter({ dir: rooms, log: () => undefined });
    expect(before.append({ workspaceId: 'ws-lead', threadId: thread, kind: 'fact', actor: { kind: 'system' }, title: 'Gate refused: task left open' }, { clientPostId: key })).not.toBeNull();
    const after = new RoomWriter({ dir: rooms, log: () => undefined });
    expect(gateCardNoted((ws, m) => after.find(ws, m), 'ws-lead', thread, key)).toBe(true);
    expect(gateCardNoted((ws, m) => after.find(ws, m), 'ws-lead', thread, verifyGateFactId('wtask-a1b2c3d4-0123456789abcdef', 123457))).toBe(false);
  });

  it('gateCardNoted: only a system card in the task thread with the key counts', () => {
    const card = (over: Partial<RoomCard>): RoomCard => ({
      version: 1, id: 'c', seq: 1, workspaceId: 'ws-lead', threadId: 'task:t' as RoomCard['threadId'], kind: 'fact', at: 1, actor: { kind: 'system' }, title: 't', clientPostId: 'k', ...over,
    });
    const findIn = (cards: RoomCard[]) => (_ws: string, m: (c: RoomCard) => boolean) => cards.find(m) ?? null;
    const thread = 'task:t' as RoomCard['threadId'];
    expect(gateCardNoted(null, 'ws-lead', thread, 'k')).toBeNull();
    expect(gateCardNoted(findIn([card({})]), 'ws-lead', thread, 'k')).toBe(true);
    expect(gateCardNoted(findIn([card({ actor: { kind: 'bot', botId: BOT } as RoomCard['actor'] })]), 'ws-lead', thread, 'k')).toBe(false);
    expect(gateCardNoted(findIn([card({ threadId: 'general' as RoomCard['threadId'] })]), 'ws-lead', thread, 'k')).toBe(false);
    expect(gateCardNoted(findIn([card({ clientPostId: 'other' })]), 'ws-lead', thread, 'k')).toBe(false);
  });

  it('restart: a task the system completed in the last day wakes its bot again with the same id; older ones and other completions do not', async () => {
    await register('done');
    await report('done');
    await ledger.recordGate('done', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await completeCheckedTask(ledger, 'done');
    await register('skip');
    await report('skip');
    await ledger.recordGate('skip', { ...PASS, skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    const skipRow = ledger.get('skip') as LedgerEntry;
    await ledger.update({ id: 'skip', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: skipRow.rev });
    const done = ledger.get('done') as LedgerEntry;
    const r = rig({ allRows: () => ledger.list({}), now: () => done.updatedAt + 1000 });
    await flush();
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0])).toEqual([verifyGateFactId('done', done.rev)]);
    const later = rig({ allRows: () => ledger.list({}), now: () => done.updatedAt + 2 * 24 * 3_600_000 });
    await flush();
    expect(later.wake).not.toHaveBeenCalled();
  });

  it('a task stopped while its worktree was being looked up gets no gate', async () => {
    await register();
    let resolveLookup: ((v: string) => void) | null = null;
    const r = rig({ worktreeOf: () => new Promise<string>((res) => { resolveLookup = res; }) });
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    await ledger.update({ id: 'task-1', status: 'cancelled', actor: { kind: 'system', workspaceId: 'ws-daemon' }, expectedRev: row.rev, summary: 'stopped by owner' });
    (resolveLookup as unknown as (v: string) => void)('/wt/task');
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('unsubscribes', async () => {
    await register();
    const r = rig();
    r.off();
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
  });
});

describe('a research task (no repository, no code)', () => {
  it('its report completes it without a gate, as its owner and unforced, even for a bot with no repository; one card, one wake', async () => {
    await register('task-1', 'research');
    const r = rig({ bot: (id) => (id === BOT ? { ...lead, repo: undefined } : null), worktreeOf: async () => null });
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(row.summary).toBe('done'); // no [forced: …]
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Research reported: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('the ledger completes only a bot\'s research row without a gate: a pane task named "research" still needs one', async () => {
    await register('task-1', 'research');
    await register('task-2', 'research', { kind: 'pane' });
    await register('task-3', 'default');
    for (const id of ['task-1', 'task-2', 'task-3']) await report(id);
    expect((await completeResearchTask(ledger, 'task-1')).entry?.status).toBe('completed');
    expect(await completeResearchTask(ledger, 'task-3')).toMatchObject({ entry: null, why: 'the task is not a research task' });
    const pane = ledger.get('task-2') as LedgerEntry;
    const forced = await ledger.update({ id: 'task-2', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: pane.rev });
    expect(forced).toMatchObject({ ok: false, error: 'gate_required' });
  });
});

describe('completeCheckedTask', () => {
  it('completes only when a passing system gate is the newest write on a reported task', async () => {
    await register('ok');
    await report('ok');
    await ledger.recordGate('ok', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'ok')).entry?.status).toBe('completed');

    await register('skip');
    await report('skip');
    await ledger.recordGate('skip', { ...PASS, command: 'none', skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'skip')).entry).toBeNull();

    await register('red');
    await report('red');
    await ledger.recordGate('red', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'red')).entry).toBeNull();

    await register('old');
    await ledger.recordGate('old', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    const reported = await report('old');
    expect(reportWasGated(reported)).toBe(false);
    expect((await completeCheckedTask(ledger, 'old')).entry).toBeNull();
    expect(ledger.get('old')?.status).toBe('review_requested');

    expect((await completeCheckedTask(ledger, 'missing')).entry).toBeNull();
  });
});

describe('describeTaskGate', () => {
  it('a base with no gate script yet says what the owner can do', () => {
    const d = describeTaskGate({ ok: false, status: 'refused', taskId: 't', code: 'no_base_gate', error: 'origin/main has no npm test script yet and the task worktree adds one' });
    expect(d.title).toBe('No gate on the default branch yet: task left open');
    expect(d.body).toContain('origin/main has no npm test script yet');
    expect(d.body).toContain('merge a test script into the default branch first');
    expect(d.body).toContain('cancel it');
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', error: 'x' }).title).toBe('Gate refused: task left open');
  });

  it('names a killed gate and an unrecorded receipt', () => {
    const killed = describeTaskGate({ ok: true, status: 'completed', taskId: 't', recorded: false, result: { exitCode: null, tail: '', at: 1, command: 'npm test' } });
    expect(killed.title).toBe('Gate was killed: task left open');
    expect(killed.body).toContain('NOT recorded');
    expect(describeTaskGate({ ok: false, status: 'busy', taskId: 't' }).title).toBe('Gate already running: task left open');
  });

  it('carries a stable code and the values its words need, the evidence left in the body', () => {
    const failed = describeTaskGate({ ok: true, status: 'completed', taskId: 't', recorded: true, result: { exitCode: 2, tail: '', at: 1, command: 'npm test' } });
    expect(failed.notice).toEqual({ code: 'gate.failed', args: { exit: 2 } });
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', code: 'no_base_gate', error: 'no script' }).notice).toEqual({ code: 'gate.noBase', args: { detail: 'no script' } });
    expect(describeTaskGate({ ok: false, status: 'busy', taskId: 't' }).notice).toEqual({ code: 'gate.busy' });
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', error: 'x' }).notice).toEqual({ code: 'gate.refused' });
  });
});

describe('a merged pull request ends its task', () => {
  const REPO = 'github.com/acme/app';
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  let seq = 0;
  /** A repo-watch PR fact with the log's real dedupe key. */
  const fact = (kind: 'pr.opened' | 'pr.merged' | 'pr.closed', pr: number, payload: Record<string, unknown> = {}, repoKey = REPO, headSha = SHA_A): Fact => {
    seq++;
    const draft = { kind, at: seq, repoKey, ref: { pr, headSha }, payload };
    return { ...draft, id: `f${seq}`, seq, dedupeKey: factDedupeKey(draft) as string };
  };
  const opened = (pr: number, branch: string, repoKey = REPO): Fact => fact('pr.opened', pr, { headRefName: branch, baseRefName: 'main', isCrossRepository: false }, repoKey);
  /** PR `pr` from `branch` merged into `base` at head `sha`, as repo-watch reads it. */
  const merged = (pr: number, branch = 'wmux/task-1', o: { base?: string | null; sha?: string; cross?: boolean; repoKey?: string } = {}): Fact => fact('pr.merged', pr, {
    headRefName: branch, isCrossRepository: o.cross ?? false, headRefOid: o.sha ?? SHA_A, ...(o.base === null ? {} : { baseRefName: o.base ?? 'main' }),
  }, o.repoKey ?? REPO, o.sha ?? SHA_A);
  /** No gate runs (refused): the report gets its card and stays open. */
  const refused = vi.fn(async (i: GateRunInput): Promise<GateRunResult> => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'no gate in this test' }));
  const NO_GATE: Partial<TaskGatePorts> = { runGate: refused };

  /** A bot code task with its repository recorded at dispatch (null: none recorded). */
  async function registerTask(id = 'task-1', o: { preset?: string; repoKey?: string | null } = {}): Promise<void> {
    const repoKey = o.repoKey === undefined ? REPO : o.repoKey;
    await ledger.register({ id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-lead', title: `task ${id}`, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: o.preset ?? 'default', ...(repoKey ? { repoKey } : {}) } });
  }

  /** A rig whose fact log is `log` (repeated dedupe keys dropped, as the real
   *  log drops them), whose task branches are `branches` (undefined: not
   *  readable) and whose task worktrees are at `heads` (default SHA_A). */
  function mergeRig(facts: Fact[], branches: Record<string, string | null | undefined>, over: Partial<TaskGatePorts> = {}, runGate?: ReturnType<typeof vi.fn<TaskGatePorts['runGate']>>, heads: Record<string, string> = {}) {
    const log: Fact[] = [];
    const append = (f: Fact): boolean => {
      if (log.some((x) => x.dedupeKey === f.dedupeKey)) return false;
      log.push(f);
      return true;
    };
    for (const f of facts) append(f);
    const subs = new Set<(f: Fact) => void>();
    const branchOf = vi.fn(async (e: LedgerEntry) => branches[e.id]);
    const headMerged = vi.fn(async (wt: string, sha: string) => (heads[wt.slice('/wt/'.length)] ?? SHA_A) === sha);
    const completeMerged = vi.fn((id: string, pr: number) => completeMergedTask(ledger, id, pr));
    const r = rig({
      worktreeOf: async (e) => `/wt/${e.id}`,
      onFact: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      prFacts: () => log,
      branchOf,
      headMerged,
      completeMerged,
      ...over,
    }, runGate);
    const emit = (f: Fact): void => {
      if (!append(f)) return;
      for (const fn of subs) fn(f);
    };
    return { ...r, emit, subs, log, branchOf, headMerged, completeMerged };
  }

  it('no gate in the repository: the skip leaves the task open, the merge of its PR completes it as its owner, one more card and wake', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, {}, recordingRunner({ ...PASS, command: 'none', skipped: 'no_gate_command' }));
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate skipped (no_gate_command): task left open']);
    const moves: string[] = [];
    ledger.onTransition((t) => moves.push(`${t.to}:${t.by.kind}`));
    r.emit(merged(2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    // The recorded skip needs no force: the merge is the row's completion.
    expect(row.completion).toEqual({ source: 'merge', pr: 2 });
    expect(row.summary).toBe('[merged: PR #2] done');
    expect(isMergeCompletion(row)).toBe(true);
    // The owner's completion a gate pass writes: the transition the worker
    // reclaim keys off.
    expect(moves).toEqual(['completed:brain']);
    expect(r.note).toHaveBeenCalledTimes(2);
    expect(r.note.mock.calls[1][2]).toBe('PR #2 merged: task completed');
    expect(r.note.mock.calls[1][4]).toBe(verifyGateFactId('task-1', row.rev));
    expect(r.note.mock.calls[1][5]).toEqual({ code: 'task.merged', args: { pr: 2 } });
    expect(r.wake).toHaveBeenCalledTimes(2);
    expect(r.wake.mock.calls[1][0]).toEqual({
      botId: BOT, workspaceId: 'ws-lead', priority: 1, threadId: 'task:task-1',
      reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', row.rev)], trigger: { kind: 'task.done' } },
    });
    expect(countOpenBotWorkers(ledger.list({ openOnly: true }), BOT, () => new Set())).toEqual({ bot: 0, factory: 0 });
    // The same fact again ends nothing more.
    for (const fn of r.subs) fn(merged(2));
    await flush();
    expect(r.note).toHaveBeenCalledTimes(2);
    expect(r.wake).toHaveBeenCalledTimes(2);
  });

  it('no recorded gate at all: the merge completes it forced, with "merged" as the reason the ledger records', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, NO_GATE);
    const reasons: Array<string | undefined> = [];
    ledger.onTransition((t) => {
      if (t.to === 'completed') reasons.push(t.forcedReason);
    });
    await report();
    await flush();
    expect(ledger.get('task-1')?.gate).toBeUndefined();
    r.emit(merged(2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(reasons).toEqual(['merged']);
    expect(row.summary).toBe('[merged: PR #2] done [forced: merged]');
    expect(row.completion).toEqual({ source: 'merge', pr: 2 });
  });

  it('after a recorded gate failure: the merge completes it, forced', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, {}, recordingRunner({ ...PASS, exitCode: 1 }));
    await report();
    await flush();
    expect(ledger.get('task-1')?.gate?.exitCode).toBe(1);
    r.emit(merged(2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.summary).toBe('[merged: PR #2] done [forced: merged]');
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate failed (exit 1): task left open', 'PR #2 merged: task completed']);
  });

  it('a gated repository merged while its gate runs: the merge completes it; the gate\'s later result writes nothing on the ended row and settles nothing', async () => {
    await registerTask();
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The late result is a failure: it must not end up on the completed row.
    const late = recordingRunner({ ...PASS, exitCode: 1 });
    const runGate = vi.fn(async (input: GateRunInput) => {
      await held;
      return late(input);
    });
    const complete = vi.fn((id: string) => completeCheckedTask(ledger, id));
    const r = mergeRig([opened(7, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, { complete }, runGate);
    await report();
    await flush();
    expect(runGate).toHaveBeenCalledTimes(1);
    r.emit(merged(7));
    await flush();
    const ended = ledger.get('task-1') as LedgerEntry;
    expect(ended.status).toBe('completed');
    (release as unknown as () => void)();
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    // Rev, gate and writer as the merge left them.
    expect(ledger.get('task-1')).toEqual(ended);
    expect(ended.gate).toBeUndefined();
    expect(ended.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(complete).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #7 merged: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a gate pass that lands first completes it; the merge after it writes nothing', async () => {
    await registerTask();
    const r = mergeRig([opened(7, 'wmux/task-1')], { 'task-1': 'wmux/task-1' });
    await report();
    await flush();
    const checked = ledger.get('task-1') as LedgerEntry;
    expect(checked.status).toBe('completed');
    r.emit(merged(7));
    await flush();
    expect(ledger.get('task-1')).toEqual(checked);
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Task checked: gate passed, task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a PR merged before the report: the report ends the task at once, with no gate run', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' });
    // Merged while the row was still working: nothing to end yet.
    r.emit(merged(2));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('working');
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('work after the merged head is not merged: new commits, or a second PR from the branch, keep the task open until that one merges', async () => {
    await registerTask();
    // PR #2 merged at SHA_A; the worker went on to SHA_B (sent back, or
    // opened #5 before repo-watch saw it) and reported again.
    const heads: Record<string, string> = { 'task-1': SHA_B };
    const r = mergeRig([opened(2, 'wmux/task-1'), merged(2)], { 'task-1': 'wmux/task-1' }, NO_GATE, undefined, heads);
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.headMerged).toHaveBeenCalledWith('/wt/task-1', SHA_A);
    // Its second PR merges with that work: now it ends, on #5.
    r.emit(opened(5, 'wmux/task-1'));
    r.emit(merged(5, 'wmux/task-1', { sha: SHA_B }));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(ledger.get('task-1')?.completion).toEqual({ source: 'merge', pr: 5 });
  });

  it('a reopened PR is found by its merge, though the log dropped its second pr.opened', async () => {
    await registerTask();
    const r = mergeRig([
      opened(2, 'wmux/task-1'), fact('pr.closed', 2, { baseRefName: 'main' }),
      opened(5, 'wmux/task-1'), fact('pr.closed', 5, { baseRefName: 'main' }),
    ], { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    // #2 reopened: its pr.opened repeats a dedupe key and is dropped.
    r.emit(opened(2, 'wmux/task-1'));
    expect(r.log.filter((f) => f.kind === 'pr.opened')).toHaveLength(2);
    r.emit(merged(2));
    await flush();
    expect(ledger.get('task-1')?.completion).toEqual({ source: 'merge', pr: 2 });
  });

  it('restart: a report whose PR was merged while the app was closed is completed by the install catch-up', async () => {
    await registerTask();
    await report();
    await ledger.recordGate('task-1', { ...PASS, command: 'none', skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    // Its card is up (before the quit): the catch-up only wakes it, and ends it.
    const r = mergeRig([opened(2, 'wmux/task-1'), merged(2)], { 'task-1': 'wmux/task-1' }, { noted: () => true });
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
    // One bot turn: the completion's wake, not also one for the report's old rev.
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('restart: a carded report whose PR is not merged is woken again once, after its merge check', async () => {
    await registerTask();
    await report();
    await ledger.recordGate('task-1', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    const row = ledger.get('task-1') as LedgerEntry;
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, { noted: () => true });
    await flush();
    expect(r.branchOf).toHaveBeenCalledTimes(1);
    expect(r.runGate).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('restart: a report not gated yet whose PR is merged gets one card and one wake, no gate (the gate waits for the merge check under way)', async () => {
    await registerTask();
    await report();
    let answer: ((b: string) => void) | null = null;
    const branchOf = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const r = mergeRig([opened(2, 'wmux/task-1'), merged(2)], {}, { branchOf, noted: () => false }, recordingRunner({ ...PASS, command: 'none', skipped: 'no_gate_command' }));
    await vi.waitFor(() => expect(answer).not.toBeNull(), { interval: 2 });
    await flush();
    (answer as unknown as (b: string) => void)('wmux/task-1');
    await flush();
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(r.runGate).not.toHaveBeenCalled();
    expect(branchOf).toHaveBeenCalledTimes(1);
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('restart: a task its merge completed in the last day wakes its bot again; a summary that only reads like one does not', async () => {
    await registerTask();
    await report();
    const done = await completeMergedTask(ledger, 'task-1', 2);
    if (!done.entry) throw new Error(done.why);
    // A worker's summary with the merge words, completed by hand.
    await registerTask('task-2');
    await report('task-2');
    const row = ledger.get('task-2') as LedgerEntry;
    const fake = await ledger.update({ id: 'task-2', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev, summary: '[merged: PR #999] done', force: true, reason: 'by hand' });
    if (!fake.ok) throw new Error(fake.message);
    expect(isMergeCompletion(fake.entry)).toBe(false);
    const r = rig({ allRows: () => ledger.list({}) });
    await flush();
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', done.entry.rev)]);
  });

  it('a merge into another base branch, one whose base was not read, or with no default branch resolved, ends nothing', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    r.emit(merged(2, 'wmux/task-1', { base: 'scratch' }));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    r.off();
    const r2 = mergeRig([opened(3, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, NO_GATE);
    r2.emit(merged(3, 'wmux/task-1', { base: null }));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    r2.off();
    const r3 = mergeRig([opened(4, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, { ...NO_GATE, baseRef: async () => null });
    r3.emit(merged(4));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    for (const x of [r, r2, r3]) expect(x.completeMerged).not.toHaveBeenCalled();
  });

  it('a PR closed without a merge leaves the task open', async () => {
    await registerTask();
    const r = mergeRig([opened(2, 'wmux/task-1')], { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    r.emit(fact('pr.closed', 2, { baseRefName: 'main', headRefName: 'wmux/task-1', isCrossRepository: false, headRefOid: SHA_A }));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(r.wake).toHaveBeenCalledTimes(1); // the gate's own
  });

  it('another PR\'s merge leaves it alone: another branch, another repository, a fork\'s PR from the same branch name, a task of another repository than its bot\'s now', async () => {
    await registerTask();
    // Started in another repository; its bot's profile names acme/app now.
    await registerTask('old', { repoKey: 'github.com/acme/old' });
    await registerTask('none', { repoKey: null });
    const r = mergeRig([], { 'task-1': 'wmux/task-1', old: 'wmux/task-1', none: 'wmux/task-1' }, NO_GATE);
    for (const id of ['task-1', 'old', 'none']) await report(id);
    await flush();
    r.emit(merged(3, 'wmux/other'));
    r.emit(merged(4, 'wmux/task-1', { repoKey: 'github.com/acme/elsewhere' }));
    r.emit(merged(5, 'wmux/task-1', { cross: true }));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    // A merge on acme/app from that branch ends only the acme/app task.
    r.emit(merged(6, 'wmux/task-1'));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(ledger.get('old')?.status).toBe('review_requested');
    expect(ledger.get('none')?.status).toBe('review_requested');
    expect(r.completeMerged.mock.calls.map((c) => c[0])).toEqual(['task-1']);
  });

  it('a task already ended, still working, or another kind of task is untouched', async () => {
    for (const id of ['done', 'gone', 'busy']) await registerTask(id);
    await registerTask('v', { preset: 'verify' });
    await registerTask('res', { preset: 'research' });
    const branches: Record<string, string> = { done: 'b/done', gone: 'b/gone', busy: 'b/busy', v: 'b/v', res: 'b/res' };
    const r = mergeRig([], branches, { ...NO_GATE, completeResearch: async () => ({ entry: null, why: 'held open for the test' }) });
    for (const id of ['done', 'gone', 'v', 'res']) await report(id);
    await flush();
    const d = ledger.get('done') as LedgerEntry;
    expect((await ledger.update({ id: 'done', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: d.rev, force: true, reason: 'by hand' })).ok).toBe(true);
    const g = ledger.get('gone') as LedgerEntry;
    expect((await ledger.update({ id: 'gone', status: 'cancelled', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: g.rev })).ok).toBe(true);
    const before = Object.fromEntries(Object.keys(branches).map((id) => [id, ledger.get(id)?.rev]));
    const wakes = r.wake.mock.calls.length;
    Object.values(branches).forEach((b, i) => r.emit(merged(10 + i, b)));
    await flush();
    for (const id of Object.keys(branches)) expect(ledger.get(id)?.rev).toBe(before[id]);
    expect(ledger.get('done')?.status).toBe('completed');
    expect(ledger.get('gone')?.status).toBe('cancelled');
    expect(ledger.get('busy')?.status).toBe('working');
    expect(ledger.get('v')?.status).toBe('review_requested');
    expect(ledger.get('res')?.status).toBe('review_requested');
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(r.wake.mock.calls.length).toBe(wakes);
  });

  it('a branch that cannot be read yet, or a completion that did not land, is tried again by the sweep', async () => {
    await registerTask();
    const branches: Record<string, string | null | undefined> = { 'task-1': undefined };
    let fail = 1;
    const completeMerged = vi.fn(async (id: string, pr: number) => (fail-- > 0 ? { entry: null, why: 'ledger write failed' } : completeMergedTask(ledger, id, pr)));
    const r = mergeRig([opened(2, 'wmux/task-1')], branches, { ...NO_GATE, completeMerged, mergeSweepMs: 20 });
    await report();
    await flush();
    r.emit(merged(2));
    await vi.waitFor(() => expect(r.branchOf.mock.calls.length).toBeGreaterThanOrEqual(3), { interval: 2 });
    expect(completeMerged).not.toHaveBeenCalled();
    branches['task-1'] = 'wmux/task-1';
    await vi.waitFor(() => expect(ledger.get('task-1')?.status).toBe('completed'), { interval: 2 });
    expect(completeMerged).toHaveBeenCalledTimes(2);
    expect(r.note.mock.calls.filter((c) => c[2] === 'PR #2 merged: task completed')).toHaveLength(1);
    r.off();
  });

  it('nothing after the unsubscribe: no sweep, no live fact, and a check under way writes nothing', async () => {
    // A report whose gate failed before a restart: the install only wakes it,
    // and its merge check (the PR is merged) waits on the branch read.
    await registerTask();
    await report();
    await ledger.recordGate('task-1', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    let answer: ((b: string) => void) | null = null;
    const branchOf = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const r = mergeRig([opened(2, 'wmux/task-1'), merged(2)], {}, { branchOf, noted: () => true, mergeSweepMs: 10 });
    await vi.waitFor(() => expect(answer).not.toBeNull(), { interval: 2 });
    await new Promise((res) => setTimeout(res, 30));
    r.off();
    expect(r.subs.size).toBe(0);
    (answer as unknown as (b: string) => void)('wmux/task-1');
    const calls = branchOf.mock.calls.length;
    r.emit(merged(3));
    await new Promise((res) => setTimeout(res, 60));
    expect(branchOf.mock.calls.length).toBe(calls);
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.runGate).not.toHaveBeenCalled();
  });
});

describe('mergesOfBranch', () => {
  const f = (seq: number, kind: Fact['kind'], pr: number, payload: Record<string, unknown> = {}, repoKey = 'acme/app'): Fact => ({ id: `f${seq}`, seq, kind, at: seq, dedupeKey: `k${seq}`, repoKey, ref: { pr, headSha: 'c'.repeat(40) }, payload });
  const m = (seq: number, pr: number, extra: Record<string, unknown> = {}, repoKey?: string) => f(seq, 'pr.merged', pr, { headRefName: 'b', isCrossRepository: false, baseRefName: 'main', headRefOid: 'd'.repeat(40), ...extra }, repoKey);
  it('each merge from the branch, newest first, with its base and merged head; never a fork\'s, another repository\'s or one missing its base', () => {
    expect(mergesOfBranch([m(1, 2), m(2, 5)], 'github.com/acme/app', 'b')).toEqual([
      { pr: 5, base: 'main', headSha: 'd'.repeat(40) },
      { pr: 2, base: 'main', headSha: 'd'.repeat(40) },
    ]);
    // The head last seen open when the merge did not read one.
    expect(mergesOfBranch([m(1, 2, { headRefOid: undefined })], 'acme/app', 'b')).toEqual([{ pr: 2, base: 'main', headSha: 'c'.repeat(40) }]);
    expect(mergesOfBranch([m(1, 2, { isCrossRepository: true }), m(2, 3, { isCrossRepository: undefined })], 'acme/app', 'b')).toEqual([]);
    expect(mergesOfBranch([m(1, 2, { baseRefName: undefined })], 'acme/app', 'b')).toEqual([]);
    expect(mergesOfBranch([m(1, 2)], 'acme/other', 'b')).toEqual([]);
    expect(mergesOfBranch([m(1, 2)], 'acme/app', 'c')).toEqual([]);
    expect(mergesOfBranch([f(1, 'pr.closed', 2, { headRefName: 'b', isCrossRepository: false, baseRefName: 'main' })], 'acme/app', 'b')).toEqual([]);
  });
});

describe('worktreeHeadMerged', () => {
  const SHA = 'e'.repeat(40);
  const fakeGit = (head: string | null, ancestor: boolean) => vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return head ? { stdout: `${head}\n`, code: 0 } : { stdout: '', code: 1 };
    return { stdout: '', code: ancestor ? 0 : 1 };
  });
  it('the merged head itself, or a HEAD behind it; not a HEAD with work after it, nor a sha that is not a commit id', async () => {
    expect(await worktreeHeadMerged(fakeGit(SHA, false), '/wt', SHA)).toBe(true);
    const behind = fakeGit('f'.repeat(40), true);
    expect(await worktreeHeadMerged(behind, '/wt', SHA)).toBe(true);
    expect(behind).toHaveBeenLastCalledWith(['merge-base', '--is-ancestor', 'HEAD', SHA], '/wt');
    expect(await worktreeHeadMerged(fakeGit('f'.repeat(40), false), '/wt', SHA)).toBe(false);
    expect(await worktreeHeadMerged(fakeGit(null, true), '/wt', SHA)).toBe(false);
    const never = fakeGit(SHA, true);
    expect(await worktreeHeadMerged(never, '/wt', '--output=x')).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('completeMergedTask', () => {
  it('completes only a reported bot code task, as its owner, with the merge as its completion', async () => {
    await register('a');
    expect(await completeMergedTask(ledger, 'a', 3)).toEqual({ entry: null, why: 'the task moved to working' });
    await report('a');
    const done = await completeMergedTask(ledger, 'a', 3);
    expect(done.entry?.status).toBe('completed');
    expect(done.entry?.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(done.entry?.completion).toEqual({ source: 'merge', pr: 3 });
    expect(done.entry?.summary?.startsWith(mergedMark(3))).toBe(true);
    await register('v', 'verify');
    await report('v');
    expect((await completeMergedTask(ledger, 'v', 3)).entry).toBeNull();
    expect((await completeMergedTask(ledger, 'missing', 3)).entry).toBeNull();
  });

  it('retries once on a stale rev, then gives up', async () => {
    await register('a');
    await report('a');
    const real = ledger;
    let stale = 1;
    const flaky = {
      get: (id: string) => real.get(id),
      update: vi.fn(async (input: Parameters<TaskLedger['update']>[0]) => (stale-- > 0
        ? { ok: false as const, error: 'stale_rev' as const, message: 'moved' }
        : real.update(input))),
    };
    expect((await completeMergedTask(flaky, 'a', 3)).entry?.status).toBe('completed');
    expect(flaky.update).toHaveBeenCalledTimes(2);
    await register('b');
    await report('b');
    const always = { get: (id: string) => real.get(id), update: vi.fn(async () => ({ ok: false as const, error: 'stale_rev' as const, message: 'moved' })) };
    expect(await completeMergedTask(always, 'b', 3)).toEqual({ entry: null, why: 'the task kept changing' });
    expect(always.update).toHaveBeenCalledTimes(2);
    expect(real.get('b')?.status).toBe('review_requested');
  });
});
