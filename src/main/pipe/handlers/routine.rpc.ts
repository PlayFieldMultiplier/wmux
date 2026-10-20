// routine.* and bot.stopMyWork — a bot's own routines and its own stop
// (shared/botRoutine.ts ROUTINE_RPC, shared/bot.ts BOT_RPC.stopMyWork),
// registered as the `routines` factory module (main/factory/factoryHost.ts).
//
// Who may call what (the handler is the gate):
//   routine.set     a bot, for itself only (the binding names it), and only in
//                   a turn on the owner's words (their message, or their
//                   answer to its question): a routine is a standing
//                   instruction the owner gave. Idempotent by clientRoutineId
//                   (default `wake:<wakeId>:r<n>` from the running wake).
//   routine.list    a bot: its own; the operator: one bot's (botId) or all.
//   routine.pause   a bot: pause or resume its own, at any time.
//   bot.stopMyWork  a bot, for itself only: its open tasks, their gates and
//                   workers are stopped and its routines paused, as the
//                   owner's Stop bot does (factory/factoryStop.ts), except
//                   that its own running turn goes on to its end (so it can
//                   say so); that turn launches no further worker.
// Anyone else is refused. Before the module started every method answers
// `not_started`.
//
// start() loads routines.json, starts the timer that fires them, lets the
// bot runtime show a routine in its wake and tell this module about parks,
// off switches and removals, and pauses / resumes routines with the "Run
// bots" switch.

import path from 'node:path';
import { BOT_EVENT, BOT_RPC, type BotEventPayload } from '../../../shared/bot';
import { ROUTINE_RPC, ROUTINE_LIMITS, type RoutineSetParams } from '../../../shared/botRoutine';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryHostDeps, type FactoryRouter } from '../../factory/factoryHost';
import { RoutineStore, getRoutineStore, routinesPath, scheduleLabel, setRoutineStore } from '../../factory/routines';
import { getBotDirectory } from '../../factory/botStore';
import { getWakeQueue, currentWakeItem } from '../../factory/wakeQueue';
import { getFactLog } from '../../factory/factLog';
import { getRoomWriter, resolveRoomPorts, runningWake, wakeOrdinals, wakeReplyTo } from '../../factory/roomWriter';
import { getFactorySettings, onFactorySettingsChanged } from '../../factory/factorySettings';
import { setBotRuntimePorts, type BotLifecycleEvent } from '../../factory/BotRuntime';
import { summarizeHandoff } from '../../factory/handoffRouter';
import { GUEST_TURN_STARTS_NO_WORKERS, guestOfRunningWake, type GuestProvenance } from '../../factory/wakeTaint';
import { getFactoryStopPorts, stopFactoryWork } from '../../factory/factoryStop';

type Refusal = { ok: false; code: 'not_authorized' | 'not_started' | 'invalid_argument'; message: string };

function refuse(code: Refusal['code'], message: string): Refusal {
  return { ok: false, code, message };
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const NOT_STARTED = refuse('not_started', 'routines are not running yet');

/** The running turn of a bot is on the owner's words: their message, or an
 *  answer to the bot's question (not one closed without an answer). Never
 *  throws. */
export function turnOnOwnerWords(botId: string, deps: { wake?: typeof currentWakeItem; handoff?: typeof summarizeHandoff } = {}): boolean {
  try {
    const item = (deps.wake ?? currentWakeItem)(botId);
    if (!item) return false;
    if (item.reason.kind === 'human') return true;
    if (item.reason.kind !== 'handoff') return false;
    const h = (deps.handoff ?? summarizeHandoff)(item.reason.handoffId);
    // A question the owner closed without an answer gave no instruction.
    return h?.ownerWords === true && h.dismissed !== true;
  } catch {
    return false;
  }
}

export interface RoutineHandlerDeps {
  store: () => RoutineStore | null;
  ownerWords?: (botId: string) => boolean;
  /** The guest provenance of the bot's running wake. Default: wakeTaint.ts. */
  guestWake?: (botId: string) => GuestProvenance;
  /** The default idempotency key of a routine set in the running turn. */
  defaultKey?: (botId: string) => string | undefined;
  stop?: (botId: string) => Promise<{ ok: boolean; workersStopped: number; gatesCancelled: number; routinesPaused?: number; code?: string; message?: string }>;
}

export function registerRoutineHandlers(router: Pick<FactoryRouter, 'register'>, deps: RoutineHandlerDeps): void {
  router.register(ROUTINE_RPC.set, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot sets its own routines');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const bot = ctx.bot;
    if (!(deps.ownerWords ?? turnOnOwnerWords)(bot.botId)) {
      return refuse('not_authorized', 'a routine is set in a turn on the owner\'s words: ask the owner, then set it when they answer');
    }
    // The owner's answer to a guest-sourced question is guest-sourced too:
    // a routine runs later as clean work, so none is saved from it.
    if ((deps.guestWake ?? guestOfRunningWake)(bot.botId) !== false) return refuse('not_authorized', GUEST_TURN_STARTS_NO_WORKERS);
    const p = obj(raw) as Partial<RoutineSetParams>;
    const key = p.clientRoutineId ?? deps.defaultKey?.(bot.botId);
    return store.set({ botId: bot.botId, workspaceId: bot.workspaceId }, { ...(p as RoutineSetParams), ...(key ? { clientRoutineId: key } : {}) });
  });

  router.register(ROUTINE_RPC.list, async (raw, ctx?: RpcContext) => {
    const store = deps.store();
    if (ctx?.bot) {
      if (!store) return NOT_STARTED;
      return { ok: true, routines: store.list(ctx.bot.botId) };
    }
    if (ctx?.operator !== true) return refuse('not_authorized', 'this call needs a bot identity or the operator');
    if (!store) return NOT_STARTED;
    const botId = obj(raw).botId;
    if (botId !== undefined && typeof botId !== 'string') return refuse('invalid_argument', 'botId must be a bot id');
    return { ok: true, routines: store.list(botId) };
  });

  router.register(ROUTINE_RPC.pause, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot pauses its own routines');
    const store = deps.store();
    if (!store) return NOT_STARTED;
    const p = obj(raw);
    // Pausing is always allowed; a resumed routine wakes the bot later as clean work.
    if (p.paused !== true && (deps.guestWake ?? guestOfRunningWake)(ctx.bot.botId) !== false) return refuse('not_authorized', GUEST_TURN_STARTS_NO_WORKERS);
    return store.pause({ kind: 'bot', botId: ctx.bot.botId, workspaceId: ctx.bot.workspaceId }, p.routineId, p.paused);
  });

  router.register(BOT_RPC.stopMyWork, async (_raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot stops only its own work');
    const botId = ctx.bot.botId;
    if (deps.stop) return deps.stop(botId);
    // No task ledger yet: nothing runs but the routines.
    const store = deps.store();
    if (!store) return NOT_STARTED;
    return { ok: true, workersStopped: 0, gatesCancelled: 0, routinesPaused: store.pauseFor(botId, 'stop') };
  });
}

/** The interval floor: ROUTINE_LIMITS.MIN_INTERVAL_MS, or, on an isolated
 *  instance (WMUX_DATA_SUFFIX set) started with WMUX_TEST_ROUTINE_MIN_MS, that
 *  shorter floor, so a live check can watch a routine fire. */
export function routineMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const test = env.WMUX_DATA_SUFFIX ? Number(env.WMUX_TEST_ROUTINE_MIN_MS) : NaN;
  return Number.isSafeInteger(test) && test >= 1_000 && test < ROUTINE_LIMITS.MIN_INTERVAL_MS ? test : ROUTINE_LIMITS.MIN_INTERVAL_MS;
}

/** What the bot runtime's lifecycle means for a bot's routines. */
export function onBotLifecycle(
  store: RoutineStore | null,
  botId: string,
  event: BotLifecycleEvent,
  factoryEnabled: () => boolean = () => getFactorySettings().enabled,
): void {
  if (!store) return;
  switch (event) {
    case 'parked': store.pauseFor(botId, 'park'); break;
    case 'resumed': store.resumeFor(botId, 'park'); break;
    case 'disabled': store.pauseFor(botId, 'off'); break;
    // A bot switched back on resumes what its own off switch paused, unless
    // "Run bots" is off too (that one resumes them when it is switched on).
    case 'enabled': if (factoryEnabled()) store.resumeFor(botId, 'off'); break;
    case 'removed': store.removeBot(botId); break;
  }
}

export function createRoutineModule(deps: Pick<FactoryHostDeps, 'wmuxDir' | 'getMainWindow'>): { start(): void; dispose(): void } {
  let off: (() => void) | null = null;
  return {
    start() {
      if (getRoutineStore()) return;
      const store = new RoutineStore({
        file: routinesPath(deps.wmuxDir()),
        minIntervalMs: routineMinIntervalMs(),
        bots: getBotDirectory,
        wakes: getWakeQueue,
        factLog: getFactLog,
        rooms: getRoomWriter,
        replyTo: (botId, workspaceId, threadId) => {
          const writer = getRoomWriter();
          return writer ? wakeReplyTo(writer, runningWake(resolveRoomPorts(), botId), workspaceId, threadId) : undefined;
        },
        factoryEnabled: () => getFactorySettings().enabled,
        emit: (payload: BotEventPayload) => {
          const win = deps.getMainWindow();
          if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, payload);
        },
      });
      try {
        store.load();
      } catch (err) {
        console.warn(`[factory] routines: ${path.basename(routinesPath(deps.wmuxDir()))} not loaded; routines stay off: ${String(err)}`);
        return;
      }
      setRoutineStore(store);
      setBotRuntimePorts({
        resolveRoutine: (routineId) => {
          const r = getRoutineStore()?.get(routineId);
          return r ? { routineId: r.id, title: r.title, prompt: r.prompt, schedule: scheduleLabel(r.schedule) } : null;
        },
        onBotLifecycle: (botId, event) => onBotLifecycle(getRoutineStore(), botId, event),
      });
      const syncSwitch = () => {
        if (getFactorySettings().enabled) store.resumeFor(undefined, 'off');
        else store.pauseFor(undefined, 'off');
      };
      syncSwitch();
      off = onFactorySettingsChanged(syncSwitch);
      store.start();
    },
    dispose() {
      off?.();
      off = null;
      getRoutineStore()?.dispose();
      setRoutineStore(null);
    },
  };
}

registerFactoryRpcModule('routines', (router, deps) => {
  registerRoutineHandlers(router, {
    store: getRoutineStore,
    defaultKey: (botId) => wakeOrdinals.next(runningWake(resolveRoomPorts() ?? {}, botId), 'routine'),
    stop: async (botId) => {
      const ports = getFactoryStopPorts();
      if (!ports) {
        const store = getRoutineStore();
        return { ok: true, workersStopped: 0, gatesCancelled: 0, routinesPaused: store ? store.pauseFor(botId, 'stop') : 0 };
      }
      const r = await stopFactoryWork(ports, { botId, keepTurn: true });
      return { ok: r.ok, workersStopped: r.workersStopped, gatesCancelled: r.gatesCancelled, ...(r.routinesPaused !== undefined ? { routinesPaused: r.routinesPaused } : {}), ...(r.code ? { code: r.code, message: r.message } : {}) };
    },
  });
  return createRoutineModule(deps);
});
