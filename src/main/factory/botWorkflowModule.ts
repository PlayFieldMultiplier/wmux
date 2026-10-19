import type { RpcContext } from '../../shared/rpc';
import type { BotProfile } from '../../shared/bot';
import { GENERAL_THREAD, type ThreadId } from '../../shared/room';
import { botFanoutIdempotencyKey } from '../../shared/wake';
import { WORKFLOW_RPC, workflowReadyFactId, type BotWorkflow } from '../../shared/botWorkflow';
import type { LedgerEntry } from '../../shared/ledger';
import { registerFactoryRpcModule, type FactoryRouter } from './factoryHost';
import { BotWorkflowStore, botWorkflowsPath, setBotWorkflowStore, validateWorkflowInput } from './botWorkflow';
import { getWorkflowFanout, type WorkflowFanout } from './workflowFanout';
import { getBotDirectory } from './botStore';
import { getBotRuntime } from './BotRuntime';
import { getWakeQueue, type WakeSinkApi } from './wakeQueue';
import { runningWakeTainted } from './wakeTaint';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { workflowWorkerPrompt } from './workflowPrompt';
import { isWakeStoppedByOwner } from './factoryStop';

export interface WorkflowPorts {
  store: BotWorkflowStore;
  profile(botId: string): BotProfile | null;
  turn(botId: string): { wakeId: string; threadId?: ThreadId } | null;
  tainted(botId: string): boolean;
  rows(): LedgerEntry[];
  fanout(): WorkflowFanout | null;
  queue(): WakeSinkApi | null;
  active(): boolean;
}
const refuse = (code: string, message: string) => ({ ok: false as const, code, message });

/** Read/write ownership is the same token-bound bot and workspace as fan-out. */
function owner(ctx: RpcContext | undefined, p: WorkflowPorts): BotProfile | null {
  if (!p.active() || ctx?.origin !== 'local' || !ctx.bot || ctx.commanderWorkspace !== ctx.bot.workspaceId) return null;
  const bot = p.profile(ctx.bot.botId);
  return bot && bot.workspaceId === ctx.bot.workspaceId ? bot : null;
}

export async function wakeReadyWorkflows(p: WorkflowPorts, workflows: readonly BotWorkflow[]): Promise<void> {
  if (!p.active()) return;
  const queue = p.queue();
  if (!queue) return;
  for (const snapshot of workflows) {
    // An earlier reconciliation may finish publishing after an owner stop.
    const w = p.store.get(snapshot.id, snapshot.botId, snapshot.workspaceId);
    if (!w || w.stoppedByOwner) continue;
    if (w.state !== 'blocked' && (w.state !== 'active' || w.steps.find((s) => s.state !== 'completed')?.state !== 'pending')) continue;
    queue.enqueue({ botId: w.botId, workspaceId: w.workspaceId, threadId: w.threadId, priority: 1,
      reason: { kind: 'facts', factIds: [workflowReadyFactId(w)], trigger: { kind: 'task.done' } } });
  }
  await queue.flush?.();
}

export function registerWorkflowRpc(router: FactoryRouter, p: WorkflowPorts): void {
  const blockAndWake = async (id: string, step: number, reason: string): Promise<void> => {
    const changed = await p.store.block(id, step, reason);
    if (changed) await wakeReadyWorkflows(p, [changed]);
  };
  router.register(WORKFLOW_RPC.read, async (params, ctx) => {
    const bot = owner(ctx, p);
    if (!bot) return refuse('NOT_AUTHORIZED', 'workflow.read requires the owning factory bot');
    if (params.workflowId === undefined) return { ok: true, workflows: p.store.list(bot.id, bot.workspaceId) };
    const workflow = typeof params.workflowId === 'string' ? p.store.get(params.workflowId, bot.id, bot.workspaceId) : null;
    return workflow ? { ok: true, workflow } : refuse('NOT_FOUND', 'workflow not found');
  });
  router.register(WORKFLOW_RPC.create, async (params, ctx) => {
    const bot = owner(ctx, p);
    const turn = bot && p.turn(bot.id);
    if (!bot?.enabled || !turn || isWakeStoppedByOwner(turn.wakeId) || !bot.repo) return refuse('FAILED_PRECONDITION', 'create a code workflow during an enabled bot wake with a repository');
    if (!validateWorkflowInput(params)) return refuse('INVALID_ARGUMENT', 'provide a stable clientWorkflowId, title and one to eight titled step prompts');
    try {
      const workflow = await p.store.create({ botId: bot.id, workspaceId: bot.workspaceId, repoKey: bot.repo.repoKey,
        threadId: turn.threadId ?? GENERAL_THREAD, tainted: p.tainted(bot.id) !== false }, params);
      await wakeReadyWorkflows(p, [workflow]);
      return { ok: true, workflow };
    } catch (error) { return refuse('FAILED_PRECONDITION', String(error)); }
  });
  router.register(WORKFLOW_RPC.advance, async (params, ctx) => {
    const bot = owner(ctx, p);
    const turn = bot && p.turn(bot.id);
    const fanout = p.fanout();
    if (!bot?.enabled || !turn || isWakeStoppedByOwner(turn.wakeId) || !fanout || !ctx) return refuse('FAILED_PRECONDITION', 'advance a workflow during an enabled bot wake');
    const key = params.idempotencyKey;
    const ordinal = typeof key === 'string' ? /^wake:.+:([1-9][0-9]*)$/.exec(key)?.[1] : undefined;
    if (!ordinal || Number(ordinal) > 16 || key !== botFanoutIdempotencyKey(turn.wakeId, Number(ordinal))) return refuse('INVALID_ARGUMENT', 'use the current wake fan-out key (workflow and fan-out share its ordinal)');
    if (typeof params.workflowId !== 'string') return refuse('INVALID_ARGUMENT', 'workflowId is required');
    try {
      await wakeReadyWorkflows(p, await p.store.reconcile(p.rows()));
      const workflow = p.store.get(params.workflowId, bot.id, bot.workspaceId);
      if (!workflow) return refuse('NOT_FOUND', 'workflow not found');
      if (bot.repo?.repoKey !== workflow.repoKey) return refuse('FAILED_PRECONDITION', 'the bot repository changed; this workflow cannot move repositories');
      if (!p.active() || isWakeStoppedByOwner(turn.wakeId) || p.turn(bot.id)?.wakeId !== turn.wakeId) return refuse('FAILED_PRECONDITION', 'the owner wake ended during reconciliation');
      const claim = await p.store.claim(workflow.id, bot.id, bot.workspaceId, key as string);
      if (!claim) return { ok: true, workflow };
      if (!p.active() || isWakeStoppedByOwner(turn.wakeId) || p.turn(bot.id)?.wakeId !== turn.wakeId) return refuse('FAILED_PRECONDITION', 'the workflow owner wake ended during persistence; inspect this durable intent before retrying');
      const step = claim.workflow.steps[claim.step];
      const predecessor = claim.workflow.steps[claim.step - 1]?.result;
      const prompt = workflowWorkerPrompt(step.prompt, predecessor);
      const dispatch = await fanout({ prompt, titles: [step.title], preset: 'default', idempotencyKey: key, threadId: workflow.threadId }, ctx,
        { id: workflow.id, step: claim.step, tainted: workflow.tainted, repoKey: workflow.repoKey, ...(predecessor?.headSha ? { baseSha: predecessor.headSha } : {}),
          onStartFailed: (reason) => { if (!p.active()) return; void blockAndWake(workflow.id, claim.step, reason).catch((error) => console.warn('[workflow] start failure persistence:', error)); } });
      if (!p.active()) return refuse('FAILED_PRECONDITION', 'workflow module stopped while fan-out was pending');
      if (!dispatch || typeof dispatch !== 'object' || !('ok' in dispatch) || dispatch.ok !== true
        || !('status' in dispatch) || dispatch.status !== 'accepted') {
        await blockAndWake(workflow.id, claim.step, 'Fan-out did not accept a new workflow step. It will not be resent automatically.');
      }
      return { ok: true, workflow: p.store.get(workflow.id, bot.id, bot.workspaceId), dispatch };
    } catch (error) {
      // A durable dispatching intent is deliberately preserved on an unknown
      // outcome. Restart reconciliation attaches its stamped task or blocks it.
      return refuse('FAILED_PRECONDITION', String(error));
    }
  });
}

registerFactoryRpcModule('workflows', (router, deps) => {
  const store = new BotWorkflowStore(botWorkflowsPath(deps.wmuxDir()));
  let active = false;
  let off: (() => void) | null = null;
  const ports: WorkflowPorts = { store, profile: (id) => getBotDirectory()?.get(id) ?? null,
    turn: (id) => getBotRuntime()?.currentTurn(id) ?? null, tainted: runningWakeTainted,
    rows: () => getTaskLedger().list(), fanout: getWorkflowFanout, queue: getWakeQueue, active: () => active };
  registerWorkflowRpc(router, ports);
  return {
    async start() {
      store.load();
      active = true;
      setBotWorkflowStore(store);
      off = getTaskLedger().onTransition(() => {
        if (active) void store.reconcile(ports.rows()).then((rows) => wakeReadyWorkflows(ports, rows)).catch((error) => console.warn('[workflow] reconciliation:', error));
      });
      await wakeReadyWorkflows(ports, await store.reconcile(ports.rows(), true));
    },
    stop() { active = false; off?.(); off = null; },
    async dispose() { active = false; off?.(); off = null; await store.flush(); setBotWorkflowStore(null); },
  };
});
