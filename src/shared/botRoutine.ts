// ─── Bot routines — wakes a bot schedules for itself ───────────────────────
//
// Contract for main/factory/routines.ts. A bot keeps its own routines
// with `routine_set` / `routine_list` / `routine_pause` (shared/botSurface.ts):
// "every hour, check the open PRs". Main stores them per bot in
// `<wmuxDir>/factory/routines.json` (main-owned) and, when one is due, emits
// a directed `schedule.fired` fact and enqueues a `routine` wake
// (shared/wake.ts) for that bot only. A routine is never the daemon's
// automation (that one holds PTY permissions).
//
// Rules main enforces: an interval of at least ROUTINE_LIMITS.MIN_INTERVAL_MS;
// at most ROUTINE_LIMITS.MAX_PER_BOT per bot; a routine missed while the app
// was closed fires once, not once per missed slot; stopping the bot
// (stop_my_work, Stop all, Stop bot), parking it or switching it off pauses
// its routines. Creating one posts a `routine` card (shared/room.ts) in the
// room; the Schedules rail page and the bot profile show a read-only
// projection. A bot reads and changes only its own; the operator reads any.

import type { ThreadId } from './room';

export const ROUTINE_RPC = {
  /** `routine_set`: create one, or change one of the caller's (routineId). */
  set: 'routine.set',
  /** `routine_list`: the caller's routines (operator: botId param, or all). */
  list: 'routine.list',
  /** `routine_pause`: pause or resume one of the caller's routines. */
  pause: 'routine.pause',
} as const;

export const ROUTINE_LIMITS = {
  MIN_INTERVAL_MS: 15 * 60_000,
  MAX_PER_BOT: 10,
  TITLE_MAX: 120,
  PROMPT_MAX: 2000,
} as const;

/** `r-` + 8..32 url-safe characters, minted by main. */
export const ROUTINE_ID_RE = /^r-[A-Za-z0-9_-]{8,32}$/;

/** When a routine fires: every `everyMs` (≥ MIN_INTERVAL_MS), or at a local
 *  time of day on the given weekdays (0 = Sunday; absent = every day). */
export type RoutineSchedule =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number; weekdays?: number[] };

export type RoutinePauseReason = 'bot' | 'owner' | 'stop' | 'park' | 'off';

export interface BotRoutine {
  id: string;
  botId: string;
  workspaceId: string;
  title: string;
  /** What the bot is told when it fires (its `routine` wake shows it). */
  prompt: string;
  schedule: RoutineSchedule;
  /** The thread its wakes run in; absent = `general`. */
  threadId?: ThreadId;
  state: 'active' | 'paused';
  paused?: { reason: RoutinePauseReason; at: number };
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;
  /** Main's next due time while active. */
  nextDueAt?: number;
}

/** `routine.set` params (the bot and workspace come from the binding). */
export interface RoutineSetParams {
  /** Change this routine of the caller's; absent = create one. */
  routineId?: string;
  title: string;
  prompt: string;
  schedule: RoutineSchedule;
  threadId?: ThreadId;
  /** Idempotency key; default `wake:<wakeId>:r<n>` from the running wake. */
  clientRoutineId?: string;
}

/** `routine.list` params. A bot lists its own; the operator may name a bot. */
export interface RoutineListParams { botId?: string; }

/** `routine.pause` params: `paused: false` resumes. */
export interface RoutinePauseParams { routineId: string; paused: boolean; }

export type RoutineResult =
  | { ok: true; routine: BotRoutine }
  | { ok: false; code: 'not_authorized' | 'invalid_argument' | 'not_found' | 'too_many' | 'not_started' | 'not_implemented'; message: string };
