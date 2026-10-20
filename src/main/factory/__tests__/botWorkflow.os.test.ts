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
import { setRedactedSecrets, __resetRedactedSecretsForTesting } from '../secretRedaction';
import { WakeTaint } from '../wakeTaint';
import { composeBotWorkerPrompt } from '../../worktask/botFanoutPresets';
import { FANOUT_PROMPT_MAX_BYTES } from '../../../shared/workTask';
import { WORKFLOW_RPC, WORKFLOW_LIMITS, workflowReadyFactId, type BotWorkflow } from '../../../shared/botWorkflow';
import type { BotProfile } from '../../../shared/bot';
import type { RpcContext } from '../../../shared/rpc';
import { workflowOwnerHandlers } from '../../ipc/handlers/workflow.handler';
import type { BrowserWindow } from 'electron';
import type { FactoryRouter } from '../factoryHost';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
let dir: string;
let guestSourced: boolean | 'unknown' = false;
const owner = { botId: 'bot-a', workspaceId: 'ws-owner', repoKey: 'github.com/acme/repo', threadId: 'general' as const, tainted: true };
const input = { clientWorkflowId: 'plan-a', title: 'Two steps', steps: [{ title: 'first', prompt: 'make first change' }, { title: 'second', prompt: 'build on first' }] };
const brain = { kind: 'brain' as const, workspaceId: owner.workspaceId };
const worker = { kind: 'worker' as const, workspaceId: 'ws-worker' };
const sha = 'a'.repeat(40);
const context: RpcContext = { origin: 'local', commanderWorkspace: owner.workspaceId, bot: { botId: owner.botId, workspaceId: owner.workspaceId, role: 'maintainer' } };
beforeEach(() => { guestSourced = false; __resetFactoryStopForTesting(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-workflow-')); });
afterEach(() => { __resetRedactedSecretsForTesting(); fs.rmSync(dir, { recursive: true, force: true }); });
const file = () => path.join(dir, 'workflows.json');
const open = () => { const store = new BotWorkflowStore(file()); store.load(); return store; };
const history = (w: BotWorkflow, count: number) => Array.from({ length: count }, (_, i) => ({ ...w,
  id: `wf-${i.toString(16).padStart(24, '0')}`, clientWorkflowId: `history-${i}`,
  botId: i < WORKFLOW_LIMITS.records ? w.botId : `bot-history-${Math.floor(i / WORKFLOW_LIMITS.records)}` }));
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
    turn: () => ({ wakeId: 'one', threadId: 'general' }), tainted: () => true, guestSourced: () => guestSourced, rows: () => ledger.list(), fanout: () => fanout, queue: () => queue, active: () => true };
  const handlers = new Map<string, Parameters<FactoryRouter['register']>[1]>();
  registerWorkflowRpc({ register: (name, fn) => { handlers.set(name, fn); }, onBotRefused: () => () => undefined }, ports);
  const call = (name: string, params: Record<string, unknown>, ctx = context) => handlers.get(name)!(params, ctx);
  return { ports, fanout, queue, call, ledger };
}

describe('owner workflow cancellation and readback', () => {
  function ipc(store: BotWorkflowStore) {
    const frame = {}; const webContents = { mainFrame: frame };
    const win = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    return { handlers: workflowOwnerHandlers(() => win, () => store), event: { sender: webContents, senderFrame: frame } };
  }
  const req = (w: BotWorkflow) => ({ botId: w.botId, workspaceId: w.workspaceId, workflowId: w.id, expectedRevision: w.revision });

  it('authorizes only the owner top frame for reads and cancellation and binds both identities', async () => {
    const store = open(); const w = await store.create(owner, input); const { handlers, event } = ipc(store);
    for (const bad of [{}, { ...event, senderFrame: {} }, { ...event, sender: {} }]) {
      expect(await handlers.read(bad, req(w))).toEqual({ ok: false, code: 'operator_only' });
      expect(await handlers.cancel(bad, req(w))).toEqual({ ok: false, code: 'operator_only' });
    }
    expect(await handlers.cancel(event, { ...req(w), workspaceId: 'other' })).toEqual({ ok: false, code: 'not_found' });
    expect(await handlers.read(event, { ...req(w), botId: 'other' })).toEqual({ ok: false, code: 'not_found' });
    expect(await handlers.cancel(event, { ...req(w), expectedRevision: 0 })).toEqual({ ok: false, code: 'invalid_request' });
    expect(store.get(w.id, w.botId, w.workspaceId)).toEqual(w);
  });

  it('durably cancels one pending plan once, retains evidence, and survives repeated restart without a wake', async () => {
    const store = open(); const w = await store.create(owner, input);
    const other = await store.create(owner, { ...input, clientWorkflowId: 'other' });
    const { handlers, event } = ipc(store);
    const first = await handlers.cancel(event, req(w));
    expect(first).toMatchObject({ ok: true, workflow: { stoppedByOwner: true, revision: 2, blockedReason: expect.stringContaining('Cancelled by owner'), lastVerifiedResult: null } });
    const disk = fs.readFileSync(file(), 'utf8');
    expect(await handlers.cancel(event, req(w))).toEqual(first);
    expect(fs.readFileSync(file(), 'utf8')).toBe(disk);
    const restored = open();
    expect(await restored.claim(w.id, w.botId, w.workspaceId, 'wake:new:1')).toBeNull();
    const h = harness(restored);
    await wakeReadyWorkflows(h.ports, await restored.reconcile([], true));
    expect(h.queue.list().some((wake) => JSON.stringify(wake.reason).includes(w.id))).toBe(false);
    expect(restored.get(other.id, other.botId, other.workspaceId)?.state).toBe('active');
  });

  it('leaves a dispatched worker ledger row untouched and preserves its task binding', async () => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' });
    await task(h.ledger, w.id); await store.reconcile(h.ledger.list());
    const current = store.get(w.id, w.botId, w.workspaceId)!; const before = h.ledger.get('wtask-one');
    const { handlers, event } = ipc(store);
    expect(await handlers.cancel(event, req(w))).toEqual({ ok: false, code: 'revision_conflict' });
    expect(await handlers.cancel(event, req(current))).toMatchObject({ ok: true, workflow: { stoppedByOwner: true, steps: [{ taskId: 'wtask-one', dispatchKey: 'wake:one:1' }, {}] } });
    expect(h.ledger.get('wtask-one')).toEqual(before);
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(h.fanout).toHaveBeenCalledTimes(1);
    expect(open().get(w.id, w.botId, w.workspaceId)?.stoppedByOwner).toBe(true);
  });

  it('returns the last recorded system-verified result and original blocking reason through both reads', async () => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    await store.claim(w.id, w.botId, w.workspaceId, 'wake:one:1');
    await task(h.ledger, w.id); await report(h.ledger); await gate(h.ledger); await complete(h.ledger);
    await store.reconcile(h.ledger.list());
    await store.claim(w.id, w.botId, w.workspaceId, 'wake:one:2'); await store.block(w.id, 1, 'Worker capacity refused');
    const current = store.get(w.id, w.botId, w.workspaceId)!; const { handlers, event } = ipc(store);
    await handlers.cancel(event, req(current));
    const botRead = await h.call(WORKFLOW_RPC.read, { workflowId: w.id });
    expect(botRead).toMatchObject({ ok: true, workflow: { blockedReason: 'Worker capacity refused', lastVerifiedResult: { taskId: 'wtask-one', headSha: sha } } });
    expect(await handlers.read(event, req(w))).toMatchObject({ ok: true, workflows: [(botRead as { workflow: unknown }).workflow] });
  });

  it('drains a real cancellation queued behind the claim before invoking fan-out', async () => {
    let cancellation: ReturnType<BotWorkflowStore['cancel']> | undefined;
    const store = new BotWorkflowStore(file(), Date.now, async (target, value) => {
      const w = (value as { workflows: BotWorkflow[] }).workflows[0];
      if (w.steps[0].state === 'dispatching' && !cancellation) {
        // Queue an owner request while the actual claim write is in flight.
        cancellation = store.cancel(w.id, w.botId, w.workspaceId, w.revision);
      }
      await fs.promises.writeFile(target, JSON.stringify(value));
    });
    const w = await store.create(owner, input); const h = harness(store);
    expect(await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' })).toMatchObject({ ok: false, code: 'FAILED_PRECONDITION' });
    expect(await cancellation).toMatchObject({ ok: true });
    expect(h.fanout).not.toHaveBeenCalled();
    expect(open().get(w.id, w.botId, w.workspaceId)?.stoppedByOwner).toBe(true);
  });

  it('returns the committed cancelled state when cancellation wins before a queued claim', async () => {
    let release: () => void = () => undefined;
    const writeHeld = new Promise<void>((resolve) => { release = resolve; });
    const store = new BotWorkflowStore(file(), Date.now, async (target, value) => {
      if ((value as { workflows: BotWorkflow[] }).workflows[0].stoppedByOwner) await writeHeld;
      await fs.promises.writeFile(target, JSON.stringify(value));
    });
    const w = await store.create(owner, input); const h = harness(store);
    const claimed = vi.spyOn(store, 'claim');
    const advancing = h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' });
    const cancelling = store.cancel(w.id, w.botId, w.workspaceId, w.revision);
    await vi.waitFor(() => expect(claimed).toHaveBeenCalled(), { timeout: 2_000 });
    release(); await cancelling;
    expect(await advancing).toMatchObject({ ok: true, workflow: { state: 'blocked', stoppedByOwner: true,
      blockedReason: expect.stringContaining('Cancelled by owner'), lastVerifiedResult: null } });
    expect(h.fanout).not.toHaveBeenCalled();
  });

  it('does not acknowledge a cancellation that failed durable storage', async () => {
    const base = open(); const w = await base.create(owner, input);
    const store = new BotWorkflowStore(file(), Date.now, async () => { throw new Error('disk failure'); }); store.load();
    await expect(store.cancel(w.id, w.botId, w.workspaceId, w.revision)).rejects.toThrow('disk failure');
    expect(store.get(w.id, w.botId, w.workspaceId)).toEqual(w);
    expect(open().get(w.id, w.botId, w.workspaceId)).toEqual(w);
  });
});

describe('durable sequential workflows', () => {
  it('caps each bot/workspace history independently and reloads more than 500 retained plans', async () => {
    const w = await open().create(owner, input);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, workflows: history(w, WORKFLOW_LIMITS.records) }));
    const store = open();
    await expect(store.create(owner, input)).rejects.toThrow('owner history is full');
    const otherBot = { ...owner, botId: 'bot-other' };
    const otherWorkspace = { ...owner, workspaceId: 'ws-other' };
    const other = await store.create(otherBot, input);
    const moved = await store.create(otherWorkspace, input);
    const restored = open();
    expect(restored.list(owner.botId, owner.workspaceId)).toHaveLength(WORKFLOW_LIMITS.records);
    expect(restored.get(other.id, otherBot.botId, otherBot.workspaceId)).toEqual(other);
    expect(restored.get(moved.id, otherWorkspace.botId, otherWorkspace.workspaceId)).toEqual(moved);
    expect(await restored.create(otherBot, input)).toEqual(other);
  });

  it('retains all records at the aggregate storage ceiling and refuses further new work without deleting evidence', async () => {
    const w = await open().create(owner, input);
    const records = history(w, WORKFLOW_LIMITS.totalRecords);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, workflows: records }));
    const before = fs.readFileSync(file(), 'utf8');
    const store = open();
    await expect(store.create({ ...owner, botId: 'bot-new' }, input)).rejects.toThrow('global workflow storage is full');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(open().list(owner.botId, owner.workspaceId)).toHaveLength(WORKFLOW_LIMITS.records);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, workflows: history(w, WORKFLOW_LIMITS.totalRecords + 1) }));
    expect(() => open()).toThrow('invalid workflow evidence');
    fs.writeFileSync(file(), JSON.stringify({ version: 1, workflows: history(w, WORKFLOW_LIMITS.records + 1).map((r) => ({ ...r, botId: owner.botId })) }));
    expect(() => open()).toThrow('owner history exceeds its limit');
  });

  it('publishes pending startup readiness without republishing old blocks or churning on unrelated ledger transitions', async () => {
    const store = open();
    const pending = await store.create(owner, input);
    const blocked = await store.create(owner, { ...input, clientWorkflowId: 'blocked' });
    await store.claim(blocked.id, owner.botId, owner.workspaceId, 'wake:old:1');
    await store.block(blocked.id, 0, 'known refusal');
    const restored = open(); const h = harness(restored);
    const blockedRevision = restored.get(blocked.id, owner.botId, owner.workspaceId)?.revision;
    await wakeReadyWorkflows(h.ports, await restored.reconcile([], true));
    expect(restored.get(blocked.id, owner.botId, owner.workspaceId)?.revision).toBe(blockedRevision);
    const facts = h.queue.list().flatMap((w) => w.reason.kind === 'facts' ? w.reason.factIds : []);
    expect(facts).toEqual([workflowReadyFactId({ ...pending, revision: pending.revision + 1 })]);
    const baseline = h.queue.list();
    const enqueue = vi.spyOn(h.queue, 'enqueue');
    const jobs: Promise<void>[] = [];
    const off = h.ledger.onTransition(() => { jobs.push(restored.reconcile(h.ledger.list()).then((changed) => wakeReadyWorkflows(h.ports, changed))); });
    try {
      for (let i = 0; i < 40; i++) await h.ledger.register({ id: `unrelated-${i}`, title: 'Other work', ownerWorkspaceId: 'ws-other', taskWorkspaceId: 'ws-unrelated-task' });
      await Promise.all(jobs);
      expect(enqueue).not.toHaveBeenCalled();
      expect(h.queue.list()).toEqual(baseline);
    } finally { off(); }
  });

  it('notifies a newly blocked startup intent once and does not replay its notification on later restarts', async () => {
    const store = open(); const w = await store.create(owner, input);
    await store.claim(w.id, owner.botId, owner.workspaceId, 'wake:old:1');
    const restored = open(); const h = harness(restored);
    await wakeReadyWorkflows(h.ports, await restored.reconcile([], true));
    const blocked = restored.get(w.id, owner.botId, owner.workspaceId)!;
    expect(blocked.state).toBe('blocked');
    const first = h.queue.list()[0];
    expect(first.reason).toMatchObject({ kind: 'facts', factIds: [workflowReadyFactId(blocked)] });
    h.queue.start(first.id); h.queue.finish(first.id); await h.queue.flush();
    const before = h.queue.list();
    for (let i = 0; i < 3; i++) {
      const next = open(); const after = harness(next); after.queue.load();
      const changed = await next.reconcile([], true);
      expect(changed).toEqual([]);
      await wakeReadyWorkflows(after.ports, changed);
      expect(after.queue.list()).toEqual(before);
      expect(next.get(w.id, owner.botId, owner.workspaceId)?.revision).toBe(blocked.revision);
    }
  });

  it('recovers a still-pending plan even when its previous ready wake finished before the crash', async () => {
    const store = open(); const w = await store.create(owner, input); const before = harness(store);
    await wakeReadyWorkflows(before.ports, [w]);
    const prior = before.queue.list()[0];
    before.queue.start(prior.id); before.queue.finish(prior.id); await before.queue.flush();
    const restored = open(); const after = harness(restored); after.queue.load();
    await wakeReadyWorkflows(after.ports, await restored.reconcile([], true));
    const next = after.queue.list({ states: ['queued'] });
    expect(next).toHaveLength(1);
    expect(next[0].reason).toMatchObject({ kind: 'facts', factIds: [workflowReadyFactId({ ...w, revision: w.revision + 1 })] });
    expect(after.queue.get(prior.id)?.state).toBe('done');
    await wakeReadyWorkflows(after.ports, await restored.reconcile([]));
    expect(after.queue.list()).toHaveLength(2);
    await after.queue.flush();
  });

  it('wakes only the workflow newly blocked by a start failure, once', async () => {
    const store = open(); const w = await store.create(owner, input);
    const other = await store.create(owner, { ...input, clientWorkflowId: 'other' });
    const h = harness(store); const enqueue = vi.spyOn(h.queue, 'enqueue');
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' });
    h.fanout.mock.calls[0][2].onStartFailed('launch failed');
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await h.queue.flush();
    expect(JSON.stringify(h.queue.list())).not.toContain(other.id);
    h.fanout.mock.calls[0][2].onStartFailed('duplicate callback');
    await store.flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'completed', 'awaiting_approval', 'already_started', undefined])('blocks a reused ordinary fan-out key instead of accepting its %s poll as a new dispatch', async (status) => {
    const store = open(); const w = await store.create(owner, input); const h = harness(store);
    h.fanout.mockResolvedValue({ ok: true, status });
    expect(await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:1' })).toMatchObject({ ok: true, workflow: { state: 'blocked' } });
    await h.call(WORKFLOW_RPC.advance, { workflowId: w.id, idempotencyKey: 'wake:one:2' });
    expect(h.fanout).toHaveBeenCalledTimes(1);
    expect(open().get(w.id, owner.botId, owner.workspaceId)?.steps[0].state).toBe('blocked');
  });
  it.each(['title', 'step title', 'prompt', 'client id'])('rejects an overlong redacted %s without replacing the loadable primary', async (field) => {
    const store = open(); const existing = await store.create(owner, input);
    const before = fs.readFileSync(file(), 'utf8');
    setRedactedSecrets([{ name: 'TEST_API_TOKEN', value: '12345678' }]);
    const definition = structuredClone({ ...input, clientWorkflowId: 'redacted-plan' });
    if (field === 'title') definition.title = 'x'.repeat(192) + '12345678';
    else if (field === 'step title') definition.steps[0].title = 'x'.repeat(192) + '12345678';
    else if (field === 'prompt') definition.steps[0].prompt = 'x'.repeat(5_992) + '12345678';
    else definition.clientWorkflowId = 'x'.repeat(120) + '12345678';
    await expect(store.create(owner, definition)).rejects.toThrow('redacted workflow definition exceeds its limits');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(open().get(existing.id, owner.botId, owner.workspaceId)).toEqual(existing);
  });

  it('ready wakes retain clean and dirty workflow provenance across restart and use newly acquired taint', async () => {
    const store = open();
    const clean = await store.create({ ...owner, tainted: false }, input);
    const dirty = await store.create({ ...owner, botId: 'bot-b' }, { ...input, clientWorkflowId: 'dirty-plan' });
    const h = harness(store);
    await wakeReadyWorkflows(h.ports, [clean, dirty]);
    const restoredQueue = new WakeQueue(path.join(dir, 'wake-queue.json'));
    restoredQueue.load();
    const wakes = restoredQueue.list({ states: ['queued'] });
    let recovered: BotWorkflowStore | null = open();
    const tracker = new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null,
      runningWake: () => null, workflow: (id) => recovered?.provenance(id) ?? null });
    const cleanWake = wakes.find((w) => w.reason.kind === 'facts' && w.reason.factIds.some((id) => id.includes(clean.id)));
    const dirtyWake = wakes.find((w) => w.reason.kind === 'facts' && w.reason.factIds.some((id) => id.includes(dirty.id)));
    if (!cleanWake || !dirtyWake) throw new Error('persisted workflow wakes are missing');
    expect(tracker.wakeTainted(cleanWake)).toBe(false);
    expect(tracker.wakeTainted(dirtyWake)).toBe(true);
    await recovered.claim(clean.id, owner.botId, owner.workspaceId, 'wake:one:1');
    await task(h.ledger, clean.id);
    await recovered.reconcile(h.ledger.list());
    recovered = open();
    expect(tracker.wakeTainted(cleanWake)).toBe(true);
    recovered = null;
    expect(tracker.wakeTainted(cleanWake)).toBe(true);
  });

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

  it('a guest-sourced wake saves no workflow, nor one whose provenance is unknown', async () => {
    const store = open(); const h = harness(store);
    for (const g of [true, 'unknown'] as const) {
      guestSourced = g;
      const r = await h.call(WORKFLOW_RPC.create, input) as { ok: boolean; message?: string };
      expect(r).toMatchObject({ ok: false, code: 'FAILED_PRECONDITION' });
      expect(r.message).toContain('external guest');
    }
    expect(store.list(owner.botId, owner.workspaceId)).toHaveLength(0);
    expect(h.queue.list()).toHaveLength(0);
    guestSourced = false;
    expect(await h.call(WORKFLOW_RPC.create, input)).toMatchObject({ ok: true });
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
