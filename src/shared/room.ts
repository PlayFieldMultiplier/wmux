// ─── Rooms — a workspace's timeline of typed cards ─────────────────────────
//
// A room is one workspace's timeline (`getWmuxDir()/factory/rooms/<ws>.jsonl`,
// main-owned). A thread is the room's sub-timeline for one PR, issue, task,
// handoff, plan or report; `general` is the room itself. Bots write cards
// with `room.post`; facts become compact `fact` cards; an `ask_person` lands
// as a `question` card backed by a WorkspaceDecision in the same thread.

import type { FactRef } from './facts';
import type { Party } from './handoff';

export type ThreadId =
  | `pr:${string}#${number}`
  | `issue:${string}#${number}`
  | `task:${string}`
  | `handoff:${string}`
  | `plan:${string}`
  | `report:${string}`
  | 'general';

export const GENERAL_THREAD: ThreadId = 'general';

const REPO_KEY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const OPAQUE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A thread id from disk or the wire, or null when it is not one. */
export function parseThreadId(value: unknown): ThreadId | null {
  if (value === 'general') return 'general';
  if (typeof value !== 'string' || value.length > 240) return null;
  const numbered = /^(pr|issue):(.+)#([1-9][0-9]{0,9})$/.exec(value);
  if (numbered) return REPO_KEY_RE.test(numbered[2]) ? (value as ThreadId) : null;
  const opaque = /^(task|handoff|plan|report):(.+)$/.exec(value);
  if (opaque) return OPAQUE_RE.test(opaque[2]) ? (value as ThreadId) : null;
  return null;
}

export function prThreadId(repoKey: string, prNumber: number): ThreadId {
  return `pr:${repoKey}#${prNumber}`;
}

export function issueThreadId(repoKey: string, issueNumber: number): ThreadId {
  return `issue:${repoKey}#${issueNumber}`;
}

export type CardKind =
  | 'fact'            // system-written from a Fact (compact)
  | 'dispatch' | 'status' | 'triage' | 'verdict' | 'report' | 'plan' | 'proposal' | 'opinion'   // bot outputs (typed)
  | 'question'        // ask_person; carries decision options; resolved inline
  | 'human'           // owner message
  | 'refusal' | 'budget';

/** The card kinds a bot may post with `room.post` (the rest are written by
 *  main: facts, questions via ask.person, human messages, refusals, budget). */
export const BOT_POSTABLE_CARD_KINDS: readonly CardKind[] = [
  'dispatch', 'status', 'triage', 'verdict', 'report', 'plan', 'proposal', 'opinion',
];

export interface RoomCard {
  version: 1;
  id: string;
  seq: number;
  workspaceId: string;
  threadId: ThreadId;
  kind: CardKind;
  at: number;
  actor: Party;
  title: string;
  /** markdown ≤ ROOM_LIMITS.CARD_BODY_MAX */
  body?: string;
  refs?: FactRef & { factId?: string; handoffId?: string; decisionId?: string; url?: string };
  /** question / proposal / plan */
  state?: 'open' | 'resolved';
}

export interface ThreadSummary { threadId: ThreadId; title: string; lastAt: number; openQuestions: number; lastKind: CardKind; }

export const ROOM_RPC = { post: 'room.post', read: 'room.read', threads: 'room.threads', resolve: 'room.resolve' } as const;

/** main → renderer push: {card} | {threadSummary}. */
export const ROOM_EVENT = 'room.event';

export const ROOM_LIMITS = { CARD_BODY_MAX: 8192, TITLE_MAX: 200, PAGE: 100, RETAIN_DAYS: 90 } as const;

/** `room.post` — a bot posts into its own workspace's room (the workspace and
 *  actor come from the caller's binding, never from params). */
export interface RoomPostParams {
  threadId?: ThreadId;
  kind: CardKind;
  title: string;
  body?: string;
  refs?: RoomCard['refs'];
}

/** `room.read` — cards of one thread (default `general` = every card). */
export interface RoomReadParams {
  threadId?: ThreadId;
  /** Cards with seq > sinceSeq. */
  sinceSeq?: number;
  limit?: number;
  /** HQ (moa) only: another workspace's room. */
  workspaceId?: string;
}

export interface RoomThreadsParams { workspaceId?: string; }

/** `room.resolve` — operator only: close a question / proposal / plan card. */
export interface RoomResolveParams { workspaceId: string; cardId: string; resolution: string; }
