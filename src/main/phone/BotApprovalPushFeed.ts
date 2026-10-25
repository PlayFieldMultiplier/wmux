// Main's half of pushing a bot's approval requests to the phone: the table of
// phone-visible requests still waiting on the owner, sent to the daemon over
// `daemon.botApprovals.set` whenever it can have changed and on every daemon
// connect. The daemon pushes what appeared and retracts what left
// (shared/botApprovalPush.ts, daemon/push/botApprovalPush.ts).
//
// A pending request expires lazily (ApprovalService.expire runs on a read),
// so the feed also republishes when the oldest one reaches its TTL: the read
// that builds the table expires it, and the daemon retracts its banner.
//
// UNKNOWN IS NOT EMPTY. The daemon reads an empty table as "nothing waits"
// and retracts every banner, so a table is sent only once the store has an
// answer. Before the approval store starts (a daemon connect can come first)
// and while it stops on quit, `rows` answers null and nothing is sent; only a
// store that failed to start sends an empty table, since nothing can be
// answered then.

import { APPROVAL_LIMITS, type ApprovalView } from '../factory/approvals';
import { phoneBotApproval } from '../../shared/phoneBotApprovals';
import { BOT_APPROVAL_PUSH_MAX_ROWS, type BotApprovalPushRow } from '../../shared/botApprovalPush';

/** The waiting, phone-visible requests among `requests`, with their bot's
 *  name: the oldest BOT_APPROVAL_PUSH_MAX_ROWS, the ones the daemon keeps. */
export function botApprovalPushRows(
  requests: readonly ApprovalView[],
  botName: (botId: string) => string | undefined,
): BotApprovalPushRow[] {
  const rows: BotApprovalPushRow[] = [];
  for (const r of requests) {
    if (r.state !== 'pending') continue;
    // Null for a card-only act (a skill, a profile change, a native tool):
    // those are decided on the desktop card and never reach the phone.
    const request = phoneBotApproval(r);
    if (!request) continue;
    const name = botName(r.botId);
    rows.push({ request, ...(name ? { botName: name } : {}) });
  }
  return rows.sort((a, b) => a.request.createdAt - b.request.createdAt).slice(0, BOT_APPROVAL_PUSH_MAX_ROWS);
}

export interface BotApprovalPushFeedDeps {
  /** The current table, or null while it is not known (nothing is sent).
   *  Reading it expires requests past their TTL. */
  rows: () => BotApprovalPushRow[] | null;
  push: (rows: BotApprovalPushRow[]) => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface BotApprovalPushFeed {
  /** Something may have changed: publish once, soon. */
  schedule(): void;
  /** Publish now (a daemon just connected). */
  publishNow(): void;
  dispose(): void;
}

/** Changes in one burst (a decide that also closes a card) go out as one push. */
const COALESCE_MS = 50;

export function createBotApprovalPushFeed(deps: BotApprovalPushFeedDeps): BotApprovalPushFeed {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let soon: unknown = null;
  let expiry: unknown = null;
  let retry: unknown = null;
  let generation = 0;

  const publishNow = (isRetry = false): void => {
    if (soon !== null) { clearTimer(soon); soon = null; }
    if (expiry !== null) { clearTimer(expiry); expiry = null; }
    if (retry !== null) { clearTimer(retry); retry = null; }
    let rows: BotApprovalPushRow[] | null;
    try {
      rows = deps.rows();
    } catch {
      return;
    }
    if (rows === null) return;
    // A refused or timed-out push is tried once more, so a retraction is not
    // lost until the next change. Each publication gets its own retry, and a
    // retry gets none, so a daemon that stays unreachable costs two pushes per
    // change; it gets the table on its next connect.
    const gen = ++generation;
    void deps.push(rows).catch(() => {
      if (isRetry || gen !== generation) return;
      retry = setTimer(() => { retry = null; publishNow(true); }, COALESCE_MS);
    });
    if (rows.length > 0) {
      const oldest = Math.min(...rows.map((row) => row.request.createdAt));
      expiry = setTimer(() => publishNow(), Math.max(0, oldest + APPROVAL_LIMITS.PENDING_TTL_MS - now()) + 1_000);
    }
  };

  function schedule(): void {
    if (soon === null) soon = setTimer(() => { soon = null; publishNow(); }, COALESCE_MS);
  }

  return {
    schedule,
    publishNow: () => publishNow(),
    dispose() {
      if (soon !== null) clearTimer(soon);
      if (expiry !== null) clearTimer(expiry);
      if (retry !== null) clearTimer(retry);
      soon = expiry = retry = null;
    },
  };
}

let feed: BotApprovalPushFeed | null = null;

/** Wired once by index.ts; null in tests and before it runs. */
export function setBotApprovalPushFeed(next: BotApprovalPushFeed | null): void {
  feed = next;
}

/** ApprovalService said its requests changed. */
export function noteBotApprovalsChanged(): void {
  feed?.schedule();
}

let storeUnavailable = false;

/** The approval store did not start: nothing can be answered, so the empty
 *  table is the answer. */
export function noteBotApprovalStoreUnavailable(): void {
  storeUnavailable = true;
  feed?.schedule();
}

/** The table to send for `requests` (the running store's list, or null when
 *  there is none), or null while it is not known. */
export function botApprovalPushTable(
  requests: readonly ApprovalView[] | null,
  botName: (botId: string) => string | undefined,
): BotApprovalPushRow[] | null {
  if (requests) return botApprovalPushRows(requests, botName);
  return storeUnavailable ? [] : null;
}
