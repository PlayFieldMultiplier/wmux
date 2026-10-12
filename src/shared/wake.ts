// ─── Wake queue — one queued turn for one bot ──────────────────────────────
//
// Persisted at `getWmuxDir()/factory/wake-queue.json` (main-owned). One
// running turn per bot; a human item while the bot is busy is queued, not
// refused. Facts that match one trigger within the batch window coalesce into
// one item. An item that was `running` when the app quit becomes
// `interrupted` on restore and is never replayed by itself.

import type { BotTrigger } from './bot';

export type WakeReason =
  | { kind: 'facts'; factIds: string[]; trigger: BotTrigger }
  | { kind: 'handoff'; handoffId: string }
  | { kind: 'human'; text: string; source: 'desktop' | 'phone'; clientMessageId?: string }
  | { kind: 'schedule'; scheduleId: string }
  | { kind: 'manual'; by: 'human' };

export type WakeState = 'queued' | 'running' | 'done' | 'dropped' | 'parked' | 'interrupted';

export interface WakeItem {
  id: string;
  botId: string;
  workspaceId: string;
  reason: WakeReason;
  /** 0 human, 1 handoff/verdict/merge, 2 batched facts */
  priority: 0 | 1 | 2;
  enqueuedAt: number;
  notBefore?: number;
  /** max 2; then a 'bot.error' fact and the item is parked with the bot */
  attempts: number;
  state: WakeState;
  dropped?: { code: 'budget' | 'duplicate' | 'bot_disabled' | 'expired' };
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
