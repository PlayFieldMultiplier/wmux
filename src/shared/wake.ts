// ─── Wake queue — one queued turn for one bot ──────────────────────────────
//
// Persisted at `getWmuxDir()/factory/wake-queue.json` (main-owned). One
// running turn per bot; a human item while the bot is busy is queued, not
// refused. Facts that match one trigger within the batch window coalesce into
// one item. An item that was `running` when the app quit becomes
// `interrupted` on restore and is never replayed by itself.

import type { BotTrigger } from './bot';
import type { ThreadId } from './room';

export type WakeReason =
  | { kind: 'facts'; factIds: string[]; trigger: BotTrigger }
  | { kind: 'handoff'; handoffId: string }
  /** `runId`: the run every wake of one owner message shares, so the
   *  handoffs its addressees send count against one chain (handoff.ts
   *  HANDOFF_LIMITS). `room`: the message went to every bot of the room.
   *  `lead`: the message went to the room, which has a coordinator, so it
   *  alone got it (humanMessage.ts). */
  | { kind: 'human'; text: string; source: 'desktop' | 'phone'; clientMessageId?: string; runId?: string; room?: true; lead?: true }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'manual'; by: 'human' }
  /** One firing of the bot's own routine (shared/botRoutine.ts). `dueAt`
   *  is the slot it fired for (a missed slot fires once, at its latest). */
  | { kind: 'routine'; routineId: string; dueAt: number }
  /** Another bot's room card named this bot in `mentions`
   *  (RoomPostParams). Main routes it as a handoff `to:{kind:'bot', botId}`
   *  so the chain's runId / depth / per-run caps apply; `handoffId` is that
   *  handoff, `cardId` the mentioning card, `fromBotId` its author. */
  | { kind: 'mention'; cardId: string; handoffId: string; fromBotId: string }
  /** The first wake of a bot the owner just added: greet and ask what
   *  to do, with choices (ask_person options). Enqueued once, by main. */
  | { kind: 'intro' };

/** A reason's dedupe key: enqueueing a reason whose key matches a kept,
 *  not-dropped item of the same bot returns that item instead. Null = never
 *  deduped (facts coalesce by trigger instead; manual and schedule wakes may
 *  repeat). Pure. */
export function wakeReasonDedupeKey(r: WakeReason): string | null {
  switch (r.kind) {
    case 'handoff': return `handoff:${r.handoffId}`;
    case 'human': return r.clientMessageId ? `human:${r.clientMessageId}` : null;
    case 'routine': return `routine:${r.routineId}:${r.dueAt}`;
    case 'mention': return `mention:${r.cardId}`;
    case 'intro': return 'intro';
    default: return null;
  }
}

export type WakeState = 'queued' | 'running' | 'done' | 'dropped' | 'parked' | 'interrupted';

export interface WakeItem {
  id: string;
  botId: string;
  workspaceId: string;
  reason: WakeReason;
  /** The room thread the wake is about (a fact's PR/issue/task thread, the
   *  handoff's thread, the thread a human message was posted in). Absent:
   *  none known. Batched facts merge only within one thread. */
  threadId?: ThreadId;
  /** 0 human, 1 handoff/verdict/merge, 2 batched facts */
  priority: 0 | 1 | 2;
  enqueuedAt: number;
  notBefore?: number;
  /** max 2; then a 'bot.error' fact and the item is parked with the bot */
  attempts: number;
  state: WakeState;
  dropped?: { code: 'budget' | 'duplicate' | 'bot_disabled' | 'expired' | 'queue_full' };
}

export const WAKE_LIMITS = {
  GLOBAL_CONCURRENT_BOTS: 3,
  /** factory-wide, below FANOUT_LIVE_TASK_CAP (8) */
  GLOBAL_CONCURRENT_WORKERS: 3,
  PER_BOT_QUEUE_CAP: 50,
  BATCH_WINDOW_MS: 20_000,
  MAX_ATTEMPTS: 2,
  /** never expires */
  HUMAN_TTL_MS: 0,
  FACT_TTL_MS: 24 * 3600_000,
} as const;

/** Idempotency key of the `ordinal`-th fan-out a bot starts inside one wake,
 *  so a retried turn cannot start the same workers twice. */
export function botFanoutIdempotencyKey(wakeId: string, ordinal: number): string {
  return `wake:${wakeId}:${ordinal}`;
}
