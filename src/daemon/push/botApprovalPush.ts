// A bot's approval request, as a push to the phone, and the retraction once it
// is no longer waiting. Main pushes the table of waiting requests
// (shared/botApprovalPush.ts); BotApprovalPushRouter turns each change of that
// table into sends, parks and retractions.
//
// The payload names the request by `botApprovalId`, NEVER `approvalId`: every
// shipped extension attaches the pane-approval category and deep link to an
// `approvalId`, and the app would answer it on `/api/approvals`, where no such
// record exists. A bot approval is answered in the app's Bots conversation
// (`workspaceId` + `threadId`) through `/api/bot-approvals/:id`.
//
// The body carries no bot-written text. Like the phone's REST view of the
// request, it is built from the request's structured fields (the act, the
// repository, the PR or issue number) and the bot's display name, so a bot
// cannot put words of its own on the owner's lock screen.

import { PUSH_RISK_CRITICAL, PUSH_RISK_NORMAL, type PushPayload } from '../../shared/push/pushEnvelope';
import { APPROVAL_NEVER_BY_RULE } from '../../shared/botApproval';
import { BOT_APPROVAL_PUSH_CAPABILITY, type BotApprovalPushRow } from '../../shared/botApprovalPush';
import type { PhoneBotApproval } from '../../shared/phoneBotApprovals';
import { APPROVAL_RETRACTION_KIND } from './approvalPushPayload';

/** The bot has no name the daemon was told. */
const BOT_NAME_FALLBACK = 'A bot';

function summary(r: PhoneBotApproval): string {
  const repo = r.repoKey;
  switch (r.action) {
    case 'merge':
      return r.prNumber !== undefined ? `Merge PR #${r.prNumber} in ${repo}` : `Merge a PR in ${repo}`;
    case 'push_default':
      return `Push to the default branch of ${repo}`;
    case 'issue_create':
      return `Open an issue in ${repo}`;
    case 'issue_close':
      return r.issueNumber !== undefined ? `Close issue #${r.issueNumber} in ${repo}` : `Close an issue in ${repo}`;
    case 'comment':
      if (r.prNumber !== undefined) return `Comment on PR #${r.prNumber} in ${repo}`;
      if (r.issueNumber !== undefined) return `Comment on issue #${r.issueNumber} in ${repo}`;
      return `Comment in ${repo}`;
    case 'release':
      return `Publish a release of ${repo}`;
    default:
      return `Approve an action in ${repo}`;
  }
}

export function buildBotApprovalPushPayload(row: BotApprovalPushRow): PushPayload {
  const r = row.request;
  return {
    title: 'Approval needed',
    body: `${row.botName ?? BOT_NAME_FALLBACK}: ${summary(r)}`,
    approvalKind: 'bot',
    botApprovalId: r.requestId,
    workspaceId: r.workspaceId,
    threadId: r.threadId,
    action: r.action,
    botId: r.botId,
    // No lock-screen affirmative: the choice is made on the card in the app.
    requiresInAppChoice: true,
    // An act no rule may ever approve (a release, a push to the default
    // branch) is `critical`, which also rings through desktop presence.
    risk: APPROVAL_NEVER_BY_RULE.has(r.action) ? PUSH_RISK_CRITICAL : PUSH_RISK_NORMAL,
  };
}

/** One banner per request. `apr-` ids are at most 36 characters. */
export function botApprovalPushCollapseId(requestId: string): string {
  return `bot-${requestId}`.slice(0, 64);
}

/** Replaces the request's banner once it is no longer waiting. No
 *  `approvalId` and no `botApprovalId`, for the reason the pane retraction
 *  gives: an extension that saw one would put the card's actions back. */
export function buildBotApprovalRetractionPayload(requestId: string): PushPayload {
  return {
    title: 'Approval resolved',
    body: 'No longer waiting — nothing to do.',
    kind: APPROVAL_RETRACTION_KIND,
    retractsBotApprovalId: requestId,
  };
}

/** Park-queue keys, kept apart from pane approval ids. */
export const BOT_APPROVAL_PARK_PREFIX = 'bot:';

export interface BotApprovalPushRouterDeps {
  /** Is presence holding this payload back? */
  suppress: (payload: PushPayload) => boolean;
  send: (payload: PushPayload, opts: { collapseId: string; requires: string }) => void;
  park: (key: string, payload: PushPayload, collapseId: string, requires: string) => void;
  forget: (key: string) => void;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * The daemon's copy of main's waiting table, and what was done with each row:
 *   - parked   held by presence under `bot:<requestId>`
 *   - sent     on the phone; retract when it leaves the table
 *   - dropped  the park queue evicted it unsent; nothing to retract
 */
export class BotApprovalPushRouter {
  private readonly deps: BotApprovalPushRouterDeps;
  private readonly rows = new Map<string, 'parked' | 'sent' | 'dropped'>();

  constructor(deps: BotApprovalPushRouterDeps) {
    this.deps = deps;
  }

  /** Main's whole table. New rows are pushed, rows that left are retracted. */
  set(table: readonly BotApprovalPushRow[]): void {
    const next = new Map(table.map((row) => [row.request.requestId, row]));
    for (const [id, state] of [...this.rows]) {
      if (next.has(id)) continue;
      this.rows.delete(id);
      if (state === 'parked') this.deps.forget(BOT_APPROVAL_PARK_PREFIX + id);
      if (state === 'sent') {
        this.deps.log?.('info', `[push] retracting the push for bot approval ${id}`);
        this.deps.send(buildBotApprovalRetractionPayload(id), {
          collapseId: botApprovalPushCollapseId(id),
          requires: BOT_APPROVAL_PUSH_CAPABILITY,
        });
      }
    }
    for (const [id, row] of next) {
      if (this.rows.has(id)) continue;
      const payload = buildBotApprovalPushPayload(row);
      const collapseId = botApprovalPushCollapseId(id);
      if (this.deps.suppress(payload)) {
        this.deps.park(BOT_APPROVAL_PARK_PREFIX + id, payload, collapseId, BOT_APPROVAL_PUSH_CAPABILITY);
        this.rows.set(id, 'parked');
      } else {
        this.deps.send(payload, { collapseId, requires: BOT_APPROVAL_PUSH_CAPABILITY });
        this.rows.set(id, 'sent');
      }
    }
  }

  /** The park queue released or evicted one of ours. */
  onParkedOutcome(key: string, outcome: 'delivered' | 'dropped'): void {
    const id = key.slice(BOT_APPROVAL_PARK_PREFIX.length);
    if (this.rows.get(id) !== 'parked') return;
    this.rows.set(id, outcome === 'delivered' ? 'sent' : 'dropped');
  }
}
