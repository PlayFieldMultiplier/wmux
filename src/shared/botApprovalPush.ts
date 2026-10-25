// ─── A bot's approval requests, pushed to the phone
//
// The requests live in Electron main (factory/approvals.ts); push lives in the
// daemon (daemon/push). So main PUSHES the table of phone-visible requests
// still waiting on the owner, over `daemon.botApprovals.set`, whenever it can
// have changed — and once on every daemon connect. The daemon compares it with
// the table it holds: a request that appears is pushed, one that leaves (it
// was decided, refused, withdrawn or expired) is retracted.
//
// FULL REPLACEMENT, not create/settle events, for the reason
// `daemon.workspaceFacts.set` gives: the two processes restart independently,
// and a table main can always rebuild from its own store needs no resync
// protocol. A daemon that restarts holds an empty table, so main's next push
// sends the requests still waiting once more, under the same collapse id —
// the phone replaces its banner rather than stacking a second one.
//
// Only devices that registered BOT_APPROVAL_PUSH_CAPABILITY receive these: an
// older app would open the payload's `approvalId`-less approval as a plain
// banner with nowhere to go.

import { parsePhoneBotApproval, type PhoneBotApproval } from './phoneBotApprovals';

export const BOT_APPROVAL_PUSH_SET_METHOD = 'daemon.botApprovals.set';

/** What a device lists in `POST /api/push-registration` `capabilities` to
 *  receive bot approval pushes. */
export const BOT_APPROVAL_PUSH_CAPABILITY = 'botApprovalPush';

/** Main sends at most this many; anything beyond is dropped by the daemon. */
export const BOT_APPROVAL_PUSH_MAX_ROWS = 200;

const BOT_NAME_MAX = 80;

/** One waiting request: the projection the phone reads it with, plus the
 *  bot's name for the banner. */
export interface BotApprovalPushRow {
  request: PhoneBotApproval;
  /** The bot's display name, as the owner sees it in wmux. */
  botName?: string;
}

function botName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > BOT_NAME_MAX) return undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return undefined;
  }
  return s;
}

/** The rows of a pushed table that are pending, phone-visible requests, or
 *  null when it is not a table. Main builds with it and the daemon parses
 *  with it, so the two agree on what counts. */
export function parseBotApprovalPushRows(value: unknown): BotApprovalPushRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: BotApprovalPushRow[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, BOT_APPROVAL_PUSH_MAX_ROWS)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const request = parsePhoneBotApproval(o.request);
    if (!request || request.state !== 'pending' || seen.has(request.requestId)) continue;
    seen.add(request.requestId);
    const name = botName(o.botName);
    rows.push({ request, ...(name ? { botName: name } : {}) });
  }
  return rows;
}
