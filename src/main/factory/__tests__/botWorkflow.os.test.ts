// @wmux-lane integration
// Exercises real temporary files, atomic workflow persistence and ledger replay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotWorkflowStore, workflowTaskResult } from '../botWorkflow';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { registerWorkflowRpc, wakeReadyWorkflows, type WorkflowPorts } from '../botWorkflowModule';
import { WakeQueue } from '../wakeQueue';
import { stopFactoryWork, __resetFactoryStopForTesting } from '../factoryStop';
import { workflowWorkerPrompt } from '../workflowPrompt';
import { composeBotWorkerPrompt } from '../../worktask/botFanoutPresets';
import { FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';
import { WORKFLOW_RPC } from '../../../shared/botWorkflow';
import type { BotProfile } from '../../../shared/bot';
import type { RpcContext } from '../../../shared/rpc';
import type { FactoryRouter } from '../factoryHost';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
let dir: string;
const owner = { botId: 'bot-a', workspaceId: 'ws-owner', repoKey: 'github.com/acme/repo', threadId: 'general' as const, tainted: true };
const input = { clientWorkflowId: 'plan-a', title: 'Two steps', steps: [{ title: 'first', prompt: 'make first change' }, { title: 'second', prompt: 'build on first' }] };
const brain = { kind: 'brain' as const, workspaceId: owner.workspaceId };
const worker = { kind: 'worker' as const, workspaceId: 'ws-worker' };
const sha = 'a'.repeat(40);
const context: RpcContext = { origin: 'local', commanderWorkspace: owner.workspaceId, bot: { botId: owner.botId, workspaceId: owner.workspaceId, role: 'maintainer' } };
beforeEach(() => { __resetFactoryStopForTesting(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-workflow-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const file = () => path.join(dir, 'workflows.json');
const open = () => { const store = new BotWorkflowStore(file()); store.load(); return store; };
async function task(ledger: TaskLedger, workflowId: string, overrides = {}) {
  return ledger.register({ id: 'wtask-one', title: 'first', ownerWorkspaceId: owner.workspaceId, taskWorkspaceId: worker.workspaceId,
    dispatch: { origin: { kind: 'bot', botId: owner.botId }, repoKey: owner.repoKey, workflow: { id: workflowId, step: 0 } }, ...overrides });
}
async function report(ledger: TaskLedger) {
  await ledger.update({ id: 'wtask-one', status: 'review_requested', actor: worker, expectedRev: ledger.get('wtask-one')!.rev });
}
async function complete(ledger: TaskLedger, force = false) {
  return ledger.update({ id: 'wtask-one', status: 'completed', actor: brain, expectedRev: ledger.get('wtask-one')!.rev, force, reason: 'operator override' });
}
async function gate(ledger: TaskLedger, exitCode = 0) {
  await ledger.recordGate('wtask-one', { exitCode, at: Date.now(), tail: 'check', command: 'npm test', headSha: sha });
}
function harness(store: BotWorkflowStore, ledger = new TaskLedger({ dir })) {
  const fanout = vi.fn(async (_params: Record<string, unknown>, _ctx: RpcContext, _binding: import('../workflowFanout').WorkflowDispatchBinding): Promise<unknown> => ({ ok: true, status: 'accepted' }));
  const queue = new WakeQueue(path.join(dir, 'wake-queue.json'));
  const ports: WorkflowPorts = { store, profile: () => ({ id: owner.botId, workspaceId: owner.workspaceId, enabled: true, repo: { repoKey: owner.repoKey } } as BotProfile),
    turn: () => ({ wakeId: 'one', threadId: 'general' }), tainted: () => true, rows: () => ledger.list(), fanout: () => fanout, queue: () => queue, active: () => true };
  const handlers = new Map<string, Parameters<FactoryRouter['register']>[1]>();
  registerWorkflowRpc({ register: (name, fn) => { handlers.set(name, fn); }, onBotRefused: () => () => undefined }, ports);
  const call = (name: string, params: Record<string, unknown>, ctx = context) => handlers.get(name)!(params, ctx);
  return { ports, fanout, queue, call, ledger };
}

describe('durable sequential workflows', () => {
  it('accepts eight long UTF-8 steps while every composed successor stays inside the existing worker byte cap', async () => {
    const store = open();
    const prompt = '한'.repeat(2_000);
    const plan = { ...input, steps: Array.from({ length: 8 }, (_, i) => ({ title: `step ${i}`, prompt })) };
    const w = await store.create(owner, plan);
    const result = { taskId: 'wtask-one', rev: 4, headSha: sha, summary: '😀'.repeat(2_000) };
    for (let i = 0; i < w.steps.length; i++) {
      const body = workflowWorkerPrompt(w.steps[i].prompt, i === 0 ? undefined : result);
      expect(Buffer.byteLength(composeBotWorkerPrompt('default', body), 'utf8')).toBeLessThanOrEqual(FANOUT_PROMPT_MAX_BYTES);
      if (i > 0) expect(body).toContain(sha);
    }
    expect(result.summary).toHaveLength(4_000);
    await expect(store.create(owner, { ...plan, clientWorkflowId: 'too-large', steps: [{ title: 'large', prompt: prompt + '한' }] })).rejects.toThrow('invalid workflow definition');
  });

  it('resumes a pending plan on restart and keeps stable create retries', async () => {
    const first = open(); const w = await first.create(owner, input);
    const next = open();
    expect((await next.create(owner, input)).id).toBe(w.id);
    await expect(next.create(owner, { ...input, title: 'different' })).rejects.toThrow('different plan');
    const h = harness(next);
    await wakeReadyWorkflows(h.ports, await next.reconcile([], true));
    expect(h.queue.list({ states: ['queued'] })).toHaveLength(1);
    await h.queue.flush();
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('pending');
  });

  it('awaits persistence before dispatch; failed claim writes start zero workers', async () => {
    const seed = open(); const w = await seed.create(owner, input);
    const broken = new BotWorkflowStore(file(), Date.now, async () => { throw new Error('disk full'); }); broken.load();
    const h = harness(broken);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' });
    expect(h.fanout).not.toHaveBeenCalled();
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('pending');
  });

  it('serializes simultaneous advance and never repeats a dispatch after ambiguous restart', async () => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    await Promise.all([1, 2].map(() => h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' })));
    expect(h.fanout).toHaveBeenCalledTimes(1);
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('dispatching');
    const recovered = open(); await recovered.reconcile([], true);
    const again = harness(recovered); await again.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(again.fanout).not.toHaveBeenCalled();
    expect(recovered.get(w.id, owner.botId, owner.workspaceId)?.state).toBe('blocked');
  });

  it('reconciles response-loss by main stamp; verified result survives restart and becomes the next worker base', async () => {
    const store = open(); const w = await store.create(owner, input); await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    const ledger = new TaskLedger({ dir }); await task(ledger, w.id); await report(ledger); await gate(ledger); expect((await complete(ledger)).ok).toBe(true);
    const next = open(); await next.reconcile(ledger.list(), true);
    expect(next.get(w.id, owner.botId, owner.workspaceId)?.steps[0].result?.headSha).toBe(sha);
    const h = harness(open(), ledger);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(h.fanout).toHaveBeenCalledTimes(1);
    expect(h.fanout.mock.calls[0]).toEqual([expect.objectContaining({ titles: ['second'] }), context,
      expect.objectContaining({ step: 1, baseSha: sha, tainted: true })]);
  });

  it.each(['failed', 'cancelled'] as const)('%s cannot advance a dependent step', async (status) => {
    const store = open(); const w = await store.create(owner, input); await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    const h = harness(store); await task(h.ledger, w.id);
    await h.ledger.update({ id: 'wtask-one', status, actor: brain, expectedRev: 1 });
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(h.fanout).not.toHaveBeenCalled(); expect(store.get(w.id, owner.botId, owner.workspaceId)?.state).toBe('blocked');
  });

  it('waits through failed gate and input required, then advances only after a fresh verified completion', async () => {
    const store = open(); const w = await store.create(owner, input); await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    const h = harness(store); await task(h.ledger, w.id); await report(h.ledger); await gate(h.ledger, 1);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' }); expect(h.fanout).not.toHaveBeenCalled();
    await h.ledger.update({ id: 'wtask-one', status: 'input_required', actor: brain, expectedRev: h.ledger.get('wtask-one')!.rev });
    await store.reconcile(h.ledger.list()); expect(store.get(w.id, owner.botId, owner.workspaceId)?.state).toBe('active');
    await report(h.ledger); await gate(h.ledger); await complete(h.ledger);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' }); expect(h.fanout).toHaveBeenCalledTimes(1);
  });

  it.each(['foreign bot', 'foreign workspace'])('never binds a stamped task from %s', async (foreign) => {
    const store = open(); const w = await store.create(owner, input); await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    const ledger = new TaskLedger({ dir }); const row = await task(ledger, w.id);
    if (foreign === 'foreign bot') row.dispatch!.origin.botId = 'other'; else row.ownerWorkspaceId = 'other';
    await store.reconcile([row], true); expect(store.get(w.id, owner.botId, owner.workspaceId)?.state).toBe('blocked');
  });

  it('preserves taint acquired by a predecessor when the next wake is clean', async () => {
    const store = open(); const w = await store.create({ ...owner, tainted: false }, input);
    await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    const h = harness(store); h.ports.tainted = () => false;
    await task(h.ledger, w.id, { dispatch: { origin: { kind: 'bot', botId: owner.botId, tainted: true }, repoKey: owner.repoKey, workflow: { id: w.id, step: 0 } } });
    await report(h.ledger); await gate(h.ledger); await complete(h.ledger);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(h.fanout.mock.calls[0][2].tainted).toBe(true);
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.tainted).toBe(true);
  });

  it('does not write after disposal while fan-out or its failure callback is pending', async () => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    let resolve!: (v: unknown) => void;
    h.fanout.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const work = h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' });
    await vi.waitFor(() => expect(h.fanout).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    h.ports.active = () => false;
    await store.flush();
    const bytes = fs.readFileSync(file(), 'utf8');
    resolve({ ok: false }); await work;
    h.fanout.mock.calls[0][2].onStartFailed('late failure');
    await store.flush();
    expect(fs.readFileSync(file(), 'utf8')).toBe(bytes);
  });

  it.each(['pending', 'between steps', 'dispatching', 'waiting'])('owner stop durably blocks %s work across restart and ignores its old ready snapshot', async (phase) => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    if (phase !== 'pending') await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    if (phase === 'between steps' || phase === 'waiting') {
      await task(h.ledger, w.id);
      if (phase === 'between steps') { await report(h.ledger); await gate(h.ledger); await complete(h.ledger); }
      await store.reconcile(h.ledger.list());
    }
    const beforeStop = store.list(owner.botId, owner.workspaceId);
    const stopped = await stopFactoryWork({ runtime: () => ({ currentTurn: () => ({ wakeId: 'one' }), interrupt: () => ({ ok: true }) }),
      botIds: () => [owner.botId], ledger: h.ledger, gates: () => null, stopWorker: async () => 0,
      blockWorkflows: (id) => store.blockFor(id), log: () => undefined }, { botId: owner.botId });
    expect(stopped).toMatchObject({ ok: true, workflowsBlocked: 1 });
    const restarted = open(); const after = harness(restarted, h.ledger); after.ports.turn = () => ({ wakeId: 'new', threadId: 'general' });
    await restarted.reconcile(h.ledger.list(), true);
    await wakeReadyWorkflows(after.ports, beforeStop);
    expect(after.queue.list()).toHaveLength(0);
    await after.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:new:1' });
    expect(after.fanout).not.toHaveBeenCalled();
    expect(restarted.get(w.id, owner.botId, owner.workspaceId)).toMatchObject({ state: 'blocked', stoppedByOwner: true });
    expect((await restarted.create(owner, input)).state).toBe('blocked');
  });

  it('stop_my_work refuses new plans in its retained wake while a later wake may create new work', async () => {
    const store = open(); const h = harness(store);
    await stopFactoryWork({ runtime: () => ({ currentTurn: () => ({ wakeId: 'one' }), interrupt: () => ({ ok: true }) }),
      botIds: () => [owner.botId], ledger: h.ledger, gates: () => null, stopWorker: async () => 0,
      blockWorkflows: (id) => store.blockFor(id), log: () => undefined }, { botId: owner.botId, keepTurn: true });
    expect(await h.call(WORKFLOW_RPC.create, input)).toMatchObject({ ok: false });
    expect(store.list(owner.botId, owner.workspaceId)).toHaveLength(0);
    h.ports.turn = () => ({ wakeId: 'new' });
    expect(await h.call(WORKFLOW_RPC.create, input)).toMatchObject({ ok: true, workflow: { state: 'active' } });
  });

  it('serializes a stop between an earlier in-flight creation and later new work, scoped to its bot', async () => {
    const store = open();
    const other = await store.create({ ...owner, botId: 'bot-other' }, input);
    const old = store.create(owner, input);
    const stop = store.blockFor(owner.botId);
    const fresh = store.create(owner, { ...input, clientWorkflowId: 'later' });
    const [first, count, last] = await Promise.all([old, stop, fresh]);
    expect(count).toBe(1);
    const recovered = open();
    expect(recovered.get(first.id, owner.botId, owner.workspaceId)?.state).toBe('blocked');
    expect(recovered.get(last.id, owner.botId, owner.workspaceId)?.state).toBe('active');
    expect(recovered.get(other.id, 'bot-other', owner.workspaceId)?.state).toBe('active');
    expect(await recovered.blockFor()).toBe(2);
    expect(await recovered.blockFor()).toBe(0);
  });

  it('rejects remote, mismatched workspace and stale-wake advance before any claim', async () => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    for (const ctx of [{ ...context, origin: 'remote' as const }, { ...context, commanderWorkspace: 'other' }]) {
      await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' }, ctx);
    }
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:old:1' });
    expect(h.fanout).not.toHaveBeenCalled(); expect(store.get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('pending');
  });

  it('refuses corrupt primary instead of restoring pending backup and refuses malformed evidence', async () => {
    const store = open(); const w = await store.create(owner, input); await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:one:1');
    fs.writeFileSync(file(), '{corrupt'); expect(() => open()).toThrow();
    fs.unlinkSync(file()); expect(() => open()).toThrow('backup recovery');
    fs.writeFileSync(file(), JSON.stringify({ version: 1, workflows: [{ ...w, steps: [{ ...w.steps[0], state: 'completed' }] }] }));
    expect(() => open()).toThrow('invalid workflow evidence');
  });

  it('reconciles stamped evidence even if the durable plan still says pending', async () => {
    const store = open(); const w = await store.create(owner, input); const ledger = new TaskLedger({ dir }); await task(ledger, w.id);
    await store.reconcile(ledger.list(), true);
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('waiting');
  });
});

describe('strict ledger completion provenance', () => {
  it.each([true, false])('manual force=%s or a PASS from an earlier report cannot supply proof', async (force) => {
    const ledger = new TaskLedger({ dir }); await task(ledger, 'wf-' + 'a'.repeat(24)); await report(ledger); await gate(ledger);
    if (!force) { await ledger.update({ id: 'wtask-one', status: 'input_required', actor: brain, expectedRev: ledger.get('wtask-one')!.rev }); await report(ledger); }
    expect((await complete(ledger, force)).ok).toBe(true);
    expect(workflowTaskResult(ledger.get('wtask-one')!)).toBeNull();
  });
  it('forced completion after a failed gate remains unverified, including after restart', async () => {
    const ledger = new TaskLedger({ dir }); await task(ledger, 'wf-' + 'a'.repeat(24)); await report(ledger); await gate(ledger, 1);
    expect((await complete(ledger, true)).ok).toBe(true);
    await ledger.flush();
    expect(workflowTaskResult(new TaskLedger({ dir }).get('wtask-one')!)).toBeNull();
    expect((await ledger.recordGate('wtask-one', { exitCode: 0, at: Date.now(), tail: '', command: 'npm test', headSha: sha })).ok).toBe(false);
    expect(workflowTaskResult(ledger.get('wtask-one')!)).toBeNull();
  });

  it('requires matching report and head; a forced failed gate never gets a completion stamp', async () => {
    const ledger = new TaskLedger({ dir }); await task(ledger, 'wf-' + 'a'.repeat(24)); await report(ledger); await gate(ledger); await complete(ledger);
    const row = ledger.get('wtask-one')!;
    expect(workflowTaskResult(row)?.headSha).toBe(sha);
    expect(workflowTaskResult({ ...row, gate: { ...row.gate!, headSha: 'b'.repeat(40) } })).toBeNull();
    expect(workflowTaskResult({ ...row, reportedAtRev: 99 })).toBeNull();
  });
});
