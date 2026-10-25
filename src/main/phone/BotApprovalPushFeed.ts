// Main's half of pushing a bot's approval requests to the phone: the table of
// phone-visible requests still waiting on the owner, sent to the daemon over
// `daemon.botApprovals.set` whenever it can have changed and on every daemon
// connect. The daemon pushes what appeared and retracts what left
// (shared/botApprovalPush.ts, daemon/push/botApprovalPush.ts).
//
// A pending request expires lazily (ApprovalService.expire runs on a read),
// so the feed also republishes when the oldest one reaches its TTL: the read
// that builds the table expires it, and the daemon retracts its banner.

import { APPROVAL_LIMITS, type ApprovalView } from '../factory/approvals';
import { phoneBotApproval } from '../../shared/phoneBotApprovals';
import type { BotApprovalPushRow } from '../../shared/botApprovalPush';

/** The waiting, phone-visible requests among `requests`, with their bot's name. */
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
  return rows;
}

export interface BotApprovalPushFeedDeps {
  /** The current table; reading it expires requests past their TTL. */
  rows: () => BotApprovalPushRow[];
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

  const publishNow = (): void => {
    if (soon !== null) { clearTimer(soon); soon = null; }
    if (expiry !== null) { clearTimer(expiry); expiry = null; }
    let rows: BotApprovalPushRow[];
    try {
      rows = deps.rows();
    } catch {
      return;
    }
    // A daemon that is not connected gets the table on its next connect.
    void deps.push(rows).catch(() => undefined);
    if (rows.length > 0) {
      const oldest = Math.min(...rows.map((row) => row.request.createdAt));
      expiry = setTimer(publishNow, Math.max(0, oldest + APPROVAL_LIMITS.PENDING_TTL_MS - now()) + 1_000);
    }
  };

  return {
    schedule() {
      if (soon === null) soon = setTimer(() => { soon = null; publishNow(); }, COALESCE_MS);
    },
    publishNow,
    dispose() {
      if (soon !== null) clearTimer(soon);
      if (expiry !== null) clearTimer(expiry);
      soon = expiry = null;
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
