// ─── Owner approvals — irreversible and public acts a bot asks for ─────────
//
// Contract for main/factory/approvals.ts, the merge executor ports, the
// approval card and Settings › Bots rules list). A bot never performs an
// irreversible or public act itself, and its workers are refused one
// (botWorkerGuard.ts): it asks with `approval_request` (BOT_APPROVAL_RPC),
// main writes the request record — reading the PR head, the gh login and the
// thread itself, never from params — and posts an `approval` card
// (shared/room.ts) with Approve / Deny / Always allow.
//
// The grant is written only by main, from the main window (the card buttons,
// the composer's "Approve N pending" chip — BOT_APPROVAL_IPC, sender-checked)
// or the phone's operator route. No bot RPC approves anything. An owner
// message also approves, main deciding: a human-authored card in the same
// thread, posted after the pending request cards, short, matching
// isOwnerApprovalText, approves that thread's pending requests shown above
// it. An approved merge waits APPROVAL_UNDO_MS with Undo on the card, then
// becomes a MergeEffect `{approvedBy:'owner', decisionId: requestId,
// expectHead}` for the one merge executor, which re-checks at run time
// (approval still standing, head unchanged, CI not failing or pending,
// `--match-head-commit`, gh login unchanged); a moved head is refused
// `head-moved` and needs a new request.
//
// "Always allow" stores an ApprovalRule; a later request it covers is
// approved by `'rule'` only when the lane-grade predicates hold (verifier
// PASS with evidence, trusted author, not tainted) and ruleAuthorize allows
// it (factory on, the lane's daily cap; the rule is the owner's consent, so
// the lane auto-merge switch does not hold it). A rule never covers force
// push or release.

import type { ThreadId } from './room';

export const BOT_APPROVAL_RPC = {
  /** `approval_request`: ask the owner for one act (ApprovalRequestParams). */
  request: 'botApproval.request',
  /** `approval_list`: the caller's requests and their state. */
  list: 'botApproval.list',
} as const;

/** Main-window IPC (operator only; the main window's top frame). */
export const BOT_APPROVAL_IPC = {
  /** Pending and recent requests (optionally of one workspace). */
  list: 'factory:approval:list',
  /** Approve / deny / undo one request, or approve with an "always allow" rule. */
  decide: 'factory:approval:decide',
  /** The remembered rules. */
  rules: 'factory:approval:rules',
  /** Revoke one rule. */
  revokeRule: 'factory:approval:revokeRule',
} as const;

/** The acts that need the owner. `merge` is executed by main first; the
 *  others are requested and recorded, and their executors may follow (UI
 *  copy says so). `skill` is a bot's own skill proposal (shared/botSkill.ts):
 *  main raises it from `skill_propose`, never from `approval_request`, and
 *  the owner's answer is the act (Approve loads the skill, Deny archives the
 *  proposal). */
export type ApprovalAction = 'merge' | 'push_default' | 'issue_create' | 'issue_close' | 'comment' | 'release' | 'skill';

export const APPROVAL_ACTIONS: readonly ApprovalAction[] = ['merge', 'push_default', 'issue_create', 'issue_close', 'comment', 'release', 'skill'];

/** The acts a bot may name in `approval_request`. */
export const BOT_REQUESTABLE_ACTIONS: readonly ApprovalAction[] = APPROVAL_ACTIONS.filter((a) => a !== 'skill');

/** Acts no rule may cover: each one always needs the owner. */
export const APPROVAL_NEVER_BY_RULE: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['release', 'push_default', 'skill']);

/** Who granted: the owner (card, chip, phone, matching message), or one of
 *  the owner's remembered rules. A rule approval is `'rule'` in MergeEffect.approvedBy. */
export type ApprovalApprover = 'owner' | 'rule';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'undone' | 'executed' | 'refused' | 'expired';

/** `apr-` + 8..32 url-safe characters, minted by main. */
export const APPROVAL_ID_RE = /^apr-[A-Za-z0-9_-]{8,32}$/;

/** The record main writes for one request. */
export interface ApprovalRequest {
  requestId: string;
  action: ApprovalAction;
  repoKey: string;
  /** merge / comment on a PR. */
  prNumber?: number;
  /** issue_close / comment on an issue. */
  issueNumber?: number;
  /** The PR head main read when the request was made (merge). */
  headSha?: string;
  /** The gh login main read when the request was made. */
  ghLogin?: string;
  /** `skill`: the proposal the card shows (its content hash) and what it
   *  would make of the skill. `repoKey` is the bot's repository or ''. */
  skill?: { name: string; hash: string; version: string; update: boolean };
  botId: string;
  workspaceId: string;
  threadId: ThreadId;
  /** The bot's one-line reason, shown as plain text. */
  reason: string;
  /** The bot's wake carried outside text (issue/PR facts, handoffs quoting
   *  them): the card says "started from outside text"; no rule approves it. */
  tainted: boolean;
  /** The `approval` card main posted. */
  cardId?: string;
  state: ApprovalState;
  decidedBy?: ApprovalApprover;
  /** The rule that approved it (decidedBy 'rule'). */
  ruleId?: string;
  decidedAt?: number;
  /** Main's reason for `refused` (head-moved, ci-failing, login-changed, …). */
  refusal?: string;
  /** `refusal` in the owner's words (never a raw code), for display. Main
   *  fills it on every view it hands out. */
  refusalText?: string;
  /** Why a covering "always allow" rule did not approve it, in the owner's
   *  words (never a raw code), for display. Main fills it on every view. */
  ruleSkippedText?: string;
  createdAt: number;
  updatedAt: number;
}

/** `botApproval.request` params (bot). Head, login, workspace and thread are
 *  main's to read; the bot names only what it asks for. */
export interface ApprovalRequestParams {
  action: ApprovalAction;
  prNumber?: number;
  issueNumber?: number;
  reason: string;
  /** Idempotency key; default `wake:<wakeId>:a<n>` from the running wake. */
  clientRequestId?: string;
}

export interface ApprovalListParams { state?: ApprovalState[]; limit?: number; }

/** An "always allow" the owner remembered. */
export interface ApprovalRule {
  ruleId: string;
  action: Exclude<ApprovalAction, 'release' | 'push_default' | 'skill'>;
  repoKey: string;
  /** One bot, or every bot of one workspace. */
  scope: { botId: string } | { workspaceId: string };
  createdAt: number;
}

/** BOT_APPROVAL_IPC.decide request. */
export interface ApprovalDecideRequest {
  requestId: string;
  decision: 'approve' | 'deny' | 'undo' | 'always';
  /** decision 'always': the rule's scope (default the requesting bot). */
  ruleScope?: 'bot' | 'workspace';
}

/** Seconds an approved merge waits with Undo on its card before main runs it. */
export const APPROVAL_UNDO_MS = 10_000;

/** Longest owner message that may count as approval. */
export const OWNER_APPROVAL_TEXT_MAX = 40;

/** Words that, alone (or with a polite tail / punctuation), mean "do the
 *  pending thing(s)". Deterministic; main matches, not a model. */
export const OWNER_APPROVAL_WORDS: readonly string[] = [
  '머지해', '머지', '머지해줘', '머지하자', '머지할거 머지해', '올려', '올려줘', '진행해', '진행', '진행해줘', '해', '해줘', '응', '그래', '좋아', 'ㅇㅇ', 'ㅇㅋ',
  'merge', 'merge it', 'merge them', 'ok', 'okay', 'go', 'go ahead', 'yes', 'approve', 'approved', 'ship it', 'lgtm',
];

/** Whether an owner message reads as approval of the pending requests above
 *  it: short, and one of OWNER_APPROVAL_WORDS once trimmed, lowercased and
 *  stripped of trailing punctuation and a 요/주세요/please. Pure. */
export function isOwnerApprovalText(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || t.length > OWNER_APPROVAL_TEXT_MAX) return false;
  const core = t
    .toLowerCase()
    .replace(/[\s.!~?,]+$/u, '')
    .replace(/\s*(please|pls)$/u, '')
    .replace(/주세요$/u, '줘')
    .replace(/요$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return core.length > 0 && OWNER_APPROVAL_WORDS.includes(core);
}
