// ─── Typed handoffs — bot ↔ bot ↔ human messages with chain limits ─────────
//
// A handoff is one typed message between parties. The router
// (main/factory/handoffRouter.ts) decides the addressee from the deployment,
// stamps attribution, counts depth and hops, and refuses over the limits;
// every refusal becomes a `handoff.refused` fact and a room card. Delivery to
// a bot is a wake-queue item, never a terminal paste. `ask_person` lands as a
// question card (a WorkspaceDecision in the thread) and on the phone.

import type { FactRef } from './facts';
import type { ThreadId } from './room';

export type Party =
  | { kind: 'bot'; workspaceId: string; botId: string }
  | { kind: 'human' }                        // the owner (desktop or phone)
  | { kind: 'system' };

export type HandoffKind = 'dispatch' | 'result' | 'ask_person' | 'answer' | 'refusal';

export type HandoffStatus = 'queued' | 'delivered' | 'answered' | 'refused' | 'expired';

export type HandoffRefusalCode = 'max_depth' | 'max_per_run' | 'no_addressee' | 'surface' | 'budget';

export interface Handoff {
  version: 1;
  /** 'h-' + ulid */
  id: string;
  /** The outer-loop run (Moa plan item or trigger instance) this hop belongs to. */
  runId: string;
  threadId: ThreadId;
  /** 0 = human/Moa origin; +1 per bot→bot hop. */
  depth: number;
  hopsInRun: number;
  from: Party;
  to: Party;
  kind: HandoffKind;
  /** handoff id */
  replyTo?: string;
  /** Decided by the router, not the model. */
  attribution: { originator: Party; chain: string[] };
  /** Where the answer lands (deployment decides). */
  landing: 'room' | 'room+phone' | 'wake';
  payload: { title: string; body: string; refs?: FactRef; options?: string[] };
  status: HandoffStatus;
  refusal?: { code: HandoffRefusalCode; detail: string };
  createdAt: number;
  updatedAt: number;
}

export const HANDOFF_LIMITS = { MAX_DEPTH: 3, MAX_PER_RUN: 20, ASK_PERSON_TTL_MS: 7 * 24 * 3600_000 } as const;

export const HANDOFF_RPC = { send: 'handoff.send', answer: 'handoff.answer', list: 'handoff.list' } as const;

/** `ask_person` has its own RPC: it raises a question card, not a bot wake. */
export const ASK_PERSON_RPC = 'ask.person' as const;

/** `handoff.send` — a bot sends a dispatch / result / refusal. The sender is
 *  the caller's binding; the addressee is decided by the router:
 *  dispatch → `toWorkspaceId`'s enabled lead (moa only), result / refusal →
 *  the `replyTo` handoff's sender. */
export interface HandoffSendParams {
  kind: 'dispatch' | 'result' | 'refusal';
  toWorkspaceId?: string;
  replyTo?: string;
  threadId?: ThreadId;
  title: string;
  body: string;
  refs?: FactRef;
}

/** `ask.person` — a bot asks the owner; lands as a question card in the
 *  thread (+ phone). The answer comes back as an `answer` handoff (a wake). */
export interface AskPersonParams {
  threadId?: ThreadId;
  title: string;
  body: string;
  options?: string[];
  refs?: FactRef;
}

/** `handoff.answer` — operator only: answer an ask_person handoff. */
export interface HandoffAnswerParams { handoffId: string; answer: string; }

/** `handoff.list` — operator only: handoffs of one workspace. */
export interface HandoffListParams { workspaceId?: string; status?: HandoffStatus[]; limit?: number; }
