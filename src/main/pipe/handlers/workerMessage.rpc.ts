// bot.workerMessage — a bot writes to the live worker of an open task it
// started (main/factory/workerMessage.ts), registered as the
// `worker-message` factory module. Only a bot (the binding names it), only
// its own open tasks, only while the factory runs and the bot may act (the
// same check as its fan-out and resume), and only into a pane whose agent
// runs.

import { BOT_RPC } from '../../../shared/bot';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryRouter } from '../../factory/factoryHost';
import { getFactorySettings } from '../../factory/factorySettings';
import { getBotRuntime } from '../../factory/BotRuntime';
import { getBotStore } from '../../factory/botStore';
import { isWakeStoppedByOwner } from '../../factory/factoryStop';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { submitToWorkerPane } from '../../factory/workerReportNudge';
import { WorkerMessageLimiter, deliverWorkerMessage, workerLivePane, type WorkerMessagePorts } from '../../factory/workerMessage';

export interface WorkerMessageRpcDeps {
  ports: () => WorkerMessagePorts | null;
  factoryEnabled: () => boolean;
  /** Why this bot may not act on its workers now (disabled, parked, its
   *  running wake stopped by the owner), or null. */
  refusal: (botId: string) => string | null;
  limiter?: WorkerMessageLimiter;
}

export function registerWorkerMessageRpc(router: Pick<FactoryRouter, 'register'>, deps: WorkerMessageRpcDeps): void {
  const limiter = deps.limiter ?? new WorkerMessageLimiter();
  router.register(BOT_RPC.workerMessage, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return { ok: false, code: 'not_authorized', message: 'a bot writes only to the workers of tasks it started' };
    const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (!deps.factoryEnabled()) return { ok: false, code: 'factory_off', message: 'the agent factory is off' };
    const refusal = deps.refusal(ctx.bot.botId);
    if (refusal) return { ok: false, code: 'not_now', message: refusal };
    const ports = deps.ports();
    if (!ports) return { ok: false, code: 'not_started', message: 'the agent factory has not started' };
    const refusalNow = (botId: string): string | null => (!deps.factoryEnabled() ? 'the agent factory is off' : deps.refusal(botId));
    return deliverWorkerMessage({ ...ports, refusal: refusalNow }, limiter, ctx.bot.botId, { taskId: p.taskId, text: p.text });
  });
}

registerFactoryRpcModule('worker-message', (router) => {
  registerWorkerMessageRpc(router, {
    ports: () => ({
      row: (taskId) => getTaskLedger().get(taskId),
      livePane: workerLivePane,
      submit: submitToWorkerPane,
      botName: (botId) => getBotStore()?.get(botId)?.name || 'the bot',
    }),
    factoryEnabled: () => getFactorySettings().enabled,
    refusal: (botId) => {
      const runtime = getBotRuntime();
      const wakeId = runtime?.currentTurn(botId)?.wakeId ?? '';
      if (wakeId && isWakeStoppedByOwner(wakeId)) return 'your work was stopped in this turn';
      const profile = getBotStore()?.get(botId) ?? null;
      if (!getFactorySettings().enabled) return 'the agent factory is off';
      if (!profile || !profile.enabled) return 'the bot was removed or disabled';
      if (profile.parked) return `the bot is parked (${profile.parked.reason})`;
      return null;
    },
  });
  return {};
});
