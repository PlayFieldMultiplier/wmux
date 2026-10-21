// handoff.* and ask.person — typed handoffs (shared/handoff.ts), registered
// with registerFactoryRpcModule (main/factory/factoryHost.ts). The router
// (main/factory/handoffRouter.ts) decides addressee, thread, attribution and
// chain limits; these handlers only gate the caller (design §13 rules 1–2):
//
//   handoff.send    a bot (the sender is its binding, never a param), not
//                   from a conversation that holds data from a signed-in
//                   task (conversationMarks.ts).
//   ask.person      a bot; every role holds it.
//   handoff.answer  the operator.
//   handoff.list    the operator.
//   bot.questionClose  a bot, for its own open question only.
//
// The router runs once the bot directory and the wake queue are wired
// (setFactoryRoomPorts); until then every call answers `not_started`.

import path from 'node:path';
import { BOT_RPC } from '../../../shared/bot';
import type { FactoryRefusal } from '../../../shared/botSurface';
import { ASK_PERSON_RPC, HANDOFF_RPC, type AskPersonParams, type HandoffListParams, type HandoffSendParams } from '../../../shared/handoff';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryModuleHandle, type FactoryRouter } from '../../factory/factoryHost';
import {
  HANDOFFS_FILENAME,
  HandoffRouter,
  deckDecisionPort,
  getHandoffRouter,
  setHandoffRouter,
} from '../../factory/handoffRouter';
import { getRoomWriter, resolveRoomPorts, type FactoryRoomPorts } from '../../factory/roomWriter';
import { getWakeTaint } from '../../factory/wakeTaint';
import { conversationSignedIn, signedInRefusal } from '../../factory/conversationMarks';
import { factoryCaller, refusal } from './room.rpc';

function params(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function notStarted(): FactoryRefusal<'not_started'> {
  return refusal('not_started', 'handoffs are not running yet');
}

export interface HandoffHandlerDeps {
  router: () => HandoffRouter | null;
  /** Whether the bot's live conversation holds data from a signed-in task
   *  (none: yes). Default: conversationMarks.ts. */
  signedIn?: (botId: string) => boolean;
}

export function handleHandoffSend(raw: unknown, ctx: RpcContext | undefined, deps: HandoffHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('bot_only', 'handoff.send is sent by a bot; the owner writes in the room');
  // What a signed-in task read stays in this conversation: no other bot is
  // handed it.
  if ((deps.signedIn ?? conversationSignedIn)(caller.bot.botId) !== false) return refusal('not_now', signedInRefusal('hand work to another bot'));
  const router = deps.router();
  if (!router) return notStarted();
  return router.send(caller.bot, params(raw) as unknown as HandoffSendParams);
}

export async function handleAskPerson(raw: unknown, ctx: RpcContext | undefined, deps: HandoffHandlerDeps): Promise<unknown> {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('bot_only', 'ask.person is asked by a bot');
  const router = deps.router();
  if (!router) return notStarted();
  return router.askPerson(caller.bot, params(raw) as unknown as AskPersonParams);
}

export async function handleHandoffAnswer(raw: unknown, ctx: RpcContext | undefined, deps: HandoffHandlerDeps): Promise<unknown> {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'operator') return refusal('operator_only', 'handoff.answer is the operator\'s');
  const router = deps.router();
  if (!router) return notStarted();
  const p = params(raw);
  if (typeof p.handoffId !== 'string' || typeof p.answer !== 'string') return refusal('invalid', 'handoffId and answer are required');
  return router.answer(p.handoffId, p.answer);
}

export function handleHandoffList(raw: unknown, ctx: RpcContext | undefined, deps: HandoffHandlerDeps): unknown {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'operator') return refusal('operator_only', 'handoff.list is the operator\'s');
  const router = deps.router();
  if (!router) return notStarted();
  const p = params(raw) as Partial<HandoffListParams>;
  return {
    ok: true,
    handoffs: router.list({
      ...(typeof p.workspaceId === 'string' ? { workspaceId: p.workspaceId } : {}),
      ...(Array.isArray(p.status) ? { status: p.status } : {}),
      ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
    }),
  };
}

export async function handleQuestionClose(raw: unknown, ctx: RpcContext | undefined, deps: HandoffHandlerDeps): Promise<unknown> {
  const caller = factoryCaller(ctx);
  if ('ok' in caller) return caller;
  if (caller.kind !== 'bot') return refusal('bot_only', 'question_close is a bot\'s, for its own questions');
  const router = deps.router();
  if (!router) return notStarted();
  return router.closeOwnQuestion(caller.bot, params(raw).cardId);
}

export function registerHandoffHandlers(router: Pick<FactoryRouter, 'register'>, deps: HandoffHandlerDeps): void {
  router.register(BOT_RPC.questionClose, (raw, ctx) => handleQuestionClose(raw, ctx, deps));
  router.register(HANDOFF_RPC.send, async (raw, ctx) => handleHandoffSend(raw, ctx, deps));
  router.register(ASK_PERSON_RPC, (raw, ctx) => handleAskPerson(raw, ctx, deps));
  router.register(HANDOFF_RPC.answer, (raw, ctx) => handleHandoffAnswer(raw, ctx, deps));
  router.register(HANDOFF_RPC.list, async (raw, ctx) => handleHandoffList(raw, ctx, deps));
}

// ── Module ─────────────────────────────────────────────────────────────────

export function createHandoffModule(
  deps: Pick<FactoryHostDeps, 'wmuxDir'>,
  resolve: () => Partial<FactoryRoomPorts> = resolveRoomPorts,
): FactoryModuleHandle {
  let router: HandoffRouter | null = null;
  return {
    async start() {
      if (router) return;
      const ports = resolve();
      if (!ports.bots || !ports.wakes) {
        console.info('[factory] handoffs: bot directory / wake queue not wired; handoffs stay off');
        return;
      }
      const wmuxDir = deps.wmuxDir();
      router = new HandoffRouter({
        file: path.join(wmuxDir, 'factory', HANDOFFS_FILENAME),
        decisions: deckDecisionPort(wmuxDir),
        ports: resolve,
        rooms: getRoomWriter,
        taint: getWakeTaint,
      });
      setHandoffRouter(router);
      await router.start();
    },
    dispose() {
      router?.dispose();
      router = null;
      setHandoffRouter(null);
    },
  };
}

registerFactoryRpcModule('handoffs', (router, deps) => {
  registerHandoffHandlers(router, { router: getHandoffRouter });
  return createHandoffModule(deps);
});
