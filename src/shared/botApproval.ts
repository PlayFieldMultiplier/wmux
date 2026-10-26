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
import type { MemoryChange } from './botMemory';
import type { RoutineQuietHours, RoutineSchedule } from './botRoutine';

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

/** The acts that need the owner. `merge` and the ACT_ACTIONS are carried
 *  out by main once approved (ACT_ACTIONS only for a request that carries
 *  its `act`, written by a build that runs them); the others are requested
 *  and recorded, and their executors may follow (UI copy says so). `skill` is a bot's own skill proposal (shared/botSkill.ts):
 *  main raises it from `skill_propose`, never from `approval_request`, and
 *  the owner's answer is the act (Approve loads the skill, Deny archives the
 *  proposal). `owner_profile` is a change a bot proposes to the owner's
 *  profile (shared/botMemory.ts, target `user`): main raises it from
 *  `memory_update`, and Approve applies the change the card shows.
 *  `native_tool` is a Hermes bot's own tool asking for permission mid-turn
 *  (a command it flags as dangerous): main raises it from the agent's ACP
 *  permission request and answers the agent once (allow once, or deny). It
 *  lives only while that turn waits: never written to approvals.json.
 *  `routine` and `bot_memory` are what the owner asked a bot for (a new
 *  routine, a change to the bot's own notes) in a conversation that took in
 *  outside text: main raises them from `routine_set` / `memory_update`
 *  instead of refusing, and Approve saves what the card shows. */
export type ApprovalAction = 'merge' | 'push_default' | 'issue_create' | 'issue_close' | 'comment' | 'release' | 'pr_close' | 'skill' | 'owner_profile' | 'native_tool' | 'routine' | 'bot_memory';

export const APPROVAL_ACTIONS: readonly ApprovalAction[] = ['merge', 'push_default', 'issue_create', 'issue_close', 'comment', 'release', 'pr_close', 'skill', 'owner_profile', 'native_tool', 'routine', 'bot_memory'];

/** The public acts main carries out on GitHub after the Undo window
 *  (factory/actExecutor.ts), for a request that carries its `act`. */
export type ActAction = 'comment' | 'issue_create' | 'issue_close' | 'pr_close' | 'release';

export const ACT_ACTIONS: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['comment', 'issue_create', 'issue_close', 'pr_close', 'release']);

/** Acts that publish text a bot wrote: approved only with a button on their
 *  card (desktop or phone) that echoes the card's payloadHash, never by
 *  typed words or the "Approve N pending" chip. */
export const TEXT_ACT_ACTIONS: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['comment', 'issue_create']);

/** Acts typed words and the "Approve N pending" chip may approve: a merge,
 *  and a close that carries no text. */
export const TYPED_APPROVABLE_ACTIONS: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['merge', 'issue_close', 'pr_close']);

/** Acts the owner decides on their own desktop card only, where the change
 *  is shown: never by a typed "ok", the "Approve N pending" chip, the phone
 *  or a rule, and never named in `approval_request` (main raises them). */
export const CARD_ONLY_ACTIONS: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['skill', 'owner_profile', 'native_tool', 'routine', 'bot_memory']);

/** The acts a bot may name in `approval_request` (a push to a default
 *  branch is not asked for: its executor has no safe source yet). */
export const BOT_REQUESTABLE_ACTIONS: readonly ApprovalAction[] = APPROVAL_ACTIONS.filter((a) => !CARD_ONLY_ACTIONS.has(a) && a !== 'push_default');

/** Acts no rule may cover: each one always needs the owner. */
export const APPROVAL_NEVER_BY_RULE: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['release', 'push_default', 'skill', 'owner_profile', 'native_tool', 'routine', 'bot_memory']);

/** Who granted: the owner (card, chip, phone, matching message), or one of
 *  the owner's remembered rules. A rule approval is `'rule'` in MergeEffect.approvedBy. */
export type ApprovalApprover = 'owner' | 'rule';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'undone' | 'executed' | 'refused' | 'expired';

/** `apr-` + 8..32 url-safe characters, minted by main. */
export const APPROVAL_ID_RE = /^apr-[A-Za-z0-9_-]{8,32}$/;

/** What an act request pins, read by main when the bot asked (never from
 *  the bot, except the text it wrote): the repository as GitHub named it,
 *  the target's node id and, on a PR, its head; the text, normalised. */
export type ApprovalAct =
  | { kind: 'comment'; target: 'pr' | 'issue'; number: number; targetNodeId: string; headSha?: string; title: string; body: string }
  | { kind: 'issue_create'; title: string; body: string }
  | { kind: 'issue_close'; number: number; targetNodeId: string; title: string; stateReason: 'completed' | 'not_planned' }
  | { kind: 'pr_close'; number: number; targetNodeId: string; headSha: string; title: string }
  | ApprovalReleaseAct;

/** A release, pinned at a commit main read on the default branch. `mode`
 *  is decided when the bot asks, from the workflows at `targetSha` (a
 *  commit's contents never change): `workflow` when a workflow there runs on
 *  pushing this tag, so main pushes the tag alone and the workflow builds
 *  and publishes the release (`workflows`: their paths); `release` when none
 *  does, so main publishes it itself (a draft first, then published), with
 *  `title`, `notes` and `prerelease` as the card shows them. In `workflow`
 *  mode `title` and `notes` are empty and `prerelease` is the tag's own
 *  shape. Never a draft once done. */
export interface ApprovalReleaseAct {
  kind: 'release';
  mode: 'workflow' | 'release';
  tagName: string;
  targetSha: string;
  /** The default branch main read; the commit must still be on it. */
  defaultBranch: string;
  title: string;
  notes: string;
  prerelease: boolean;
  workflows: string[];
  /** A push to the default branch surely ran a workflow at `targetSha`, so
   *  a commit with no check at all has not started its checks (read with the
   *  request: the workflows at a commit do not change). Absent on a request
   *  an earlier build stored: the run reads the workflows. */
  checksExpected?: boolean;
  draft: false;
}
/** An act's pins of the repository. */
export interface ApprovalActRepo {
  /** `owner/repo` as GitHub answered it. */
  fullName: string;
  nodeId: string;
  /** GitHub's numeric repository id (it survives a rename, as node_id does). */
  id: number;
}

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
  /** `owner_profile`: the change the card shows. `old` is the entry it
   *  replaces or removes as it read when the bot asked; Approve applies the
   *  change only while that entry still reads so. */
  ownerProfile?: MemoryChange;
  /** `native_tool`: what the agent asked to run, as its permission request
   *  named it (secrets redacted, capped). `repoKey` is ''. */
  nativeTool?: { title: string; command: string };
  /** `routine`: the new routine as routine_set checked it, shown whole on
   *  the card; Approve saves it, checked again. `repoKey` is ''. */
  routine?: ApprovalRoutine;
  /** `bot_memory`: the change to the bot's own notes the card shows (`old`
   *  as for ownerProfile). `repoKey` is ''. */
  botMemory?: MemoryChange;
  /** `routine` / `bot_memory`, and an `owner_profile` asked from such a
   *  conversation: the owner's `human` card the request was asked on. */
  ownerCardId?: string;
  /** An act main carries out (ACT_ACTIONS): what it pins. A request without
   *  it (an older build's) stays recorded only. */
  act?: ApprovalAct;
  actRepo?: ApprovalActRepo;
  /** sha256 (lowercase hex) of the card's `wmux-payload` fences' inner texts
   *  joined by U+0000 (factory/actPayload.ts). An approval echoes it. */
  payloadHash?: string;
  /** What the act made on GitHub, once done. */
  result?: { url: string; id?: number; number?: number };
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
  /** The first unmet condition of that skip, when it is one of the rule's
   *  own (ruleSkipCondition), for the card to say in the owner's language.
   *  Main fills it on every view. */
  ruleSkippedCondition?: ApprovalRuleCondition;
  /** A merge no rule covers: what an "always allow" rule made from it would
   *  still lack in this workspace (no Reviewer bot, no required checks on
   *  the repository, an author the lane does not trust), read when it was
   *  asked. The card says it under Always allow. */
  ruleNeeds?: ApprovalRuleNeed[];
  createdAt: number;
  updatedAt: number;
}

/** A routine a `routine` request saves (shared/botRoutine.ts). */
export interface ApprovalRoutine {
  title: string;
  prompt: string;
  schedule: RoutineSchedule;
  quietHours?: RoutineQuietHours;
  threadId?: ThreadId;
}

/** `botApproval.request` params (bot). Head, login, workspace and thread are
 *  main's to read; the bot names only what it asks for. */
export interface ApprovalRequestParams {
  action: ApprovalAction;
  prNumber?: number;
  issueNumber?: number;
  reason: string;
  /** comment / issue_create: the text to publish, shown whole on the card. */
  body?: string;
  /** issue_create: the issue's title. */
  title?: string;
  /** issue_close: completed (default) or not_planned. */
  stateReason?: 'completed' | 'not_planned';
  /** release: the tag to publish (one ref segment). */
  tagName?: string;
  /** release: the full commit SHA; default the default branch's head now. */
  targetSha?: string;
  /** release: the release notes (`title` is its name, default the tag). */
  notes?: string;
  /** release: a prerelease, never marked Latest (default false). */
  prerelease?: boolean;
  /** Idempotency key; default `wake:<wakeId>:a<n>` from the running wake. */
  clientRequestId?: string;
}

export interface ApprovalListParams { state?: ApprovalState[]; limit?: number; }

/** An "always allow" the owner remembered. It covers the requests the
 *  scope's bot asks for (ApprovalRequest.botId, the asking bot), or that any
 *  bot of the workspace asks for, whoever's worker authored the PR. */
export interface ApprovalRule {
  ruleId: string;
  action: Exclude<ApprovalAction, 'release' | 'push_default' | 'skill' | 'owner_profile' | 'native_tool' | 'routine' | 'bot_memory'>;
  repoKey: string;
  /** One bot, or every bot of one workspace. */
  scope: { botId: string } | { workspaceId: string };
  createdAt: number;
}

/** What an "always allow" rule needs before it merges by itself, as the
 *  approval card names it: the request did not start from outside text, it
 *  was asked by the bot the rule covers, a verifier passed the head, the
 *  repository has required checks and they are green, the author is trusted. */
export type ApprovalRuleCondition = 'outside' | 'asker' | 'verifier' | 'noChecks' | 'checks' | 'author';

/** The conditions a workspace can lack for good (the card names them before
 *  a rule exists). */
export type ApprovalRuleNeed = Extract<ApprovalRuleCondition, 'verifier' | 'noChecks' | 'author'>;

/** The code a request gets when a bot-scoped rule on the same act and
 *  repository covers another bot (ApprovalRequest.botId is the asking bot). */
export const RULE_OTHER_ASKER = 'rule-other-asker';

/** Which rule condition one skip code is (`predicate:reason` from the merge
 *  lane, or a bare code), or null for any other. Pure. */
export function ruleConditionOf(code: string): ApprovalRuleCondition | null {
  if (code === 'tainted-origin') return 'outside';
  if (code === RULE_OTHER_ASKER) return 'asker';
  if (code.startsWith('verifier-pass-at-head:')) return 'verifier';
  if (code === 'required-checks-green:no-required-checks') return 'noChecks';
  if (code.startsWith('required-checks-green:')) return 'checks';
  if (code.startsWith('author-trusted:')) return 'author';
  return null;
}

const RULE_CONDITION_ORDER: readonly ApprovalRuleCondition[] = ['outside', 'asker', 'verifier', 'noChecks', 'checks', 'author'];

/** The first unmet condition among skip codes: the rule's own conditions in
 *  the order Settings lists them, else the first code. Null for none. Pure. */
export function firstRuleSkip(codes: readonly string[]): { code: string; condition: ApprovalRuleCondition | null } | null {
  let best: { code: string; condition: ApprovalRuleCondition } | null = null;
  for (const code of codes) {
    const condition = ruleConditionOf(code);
    if (condition && (!best || RULE_CONDITION_ORDER.indexOf(condition) < RULE_CONDITION_ORDER.indexOf(best.condition))) best = { code, condition };
  }
  if (best) return best;
  return codes.length > 0 ? { code: codes[0], condition: null } : null;
}

/** BOT_APPROVAL_IPC.decide request. */
export interface ApprovalDecideRequest {
  requestId: string;
  decision: 'approve' | 'deny' | 'undo' | 'always';
  /** decision 'always': the rule's scope (default the requesting bot). */
  ruleScope?: 'bot' | 'workspace';
  /** decision 'approve' on an act: the payloadHash of the card the owner
   *  read. A request that carries one refuses an approval without it
   *  (`client_update_required`) and with another one (`changed`). */
  payloadHash?: string;
  /** Where the decision came from, logged with it: the card's button, the
   *  "Approve N pending" chip. A text act refuses the chip. */
  source?: 'card' | 'chip';
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
