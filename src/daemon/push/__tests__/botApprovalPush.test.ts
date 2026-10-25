import { describe, expect, it } from 'vitest';
import {
  BotApprovalPushRouter,
  buildBotApprovalPushPayload,
  botApprovalPushCollapseId,
} from '../botApprovalPush';
import type { PushPayload } from '../../../shared/push/pushEnvelope';
import { DeferredPushQueue } from '../presence';
import type { BotApprovalPushRow } from '../../../shared/botApprovalPush';
import type { PhoneBotApproval } from '../../../shared/phoneBotApprovals';

function row(over: Partial<PhoneBotApproval> = {}, botName: string | null = 'Reviewer'): BotApprovalPushRow {
  return {
    request: {
      requestId: 'apr-abcdefgh12',
      action: 'merge',
      workspaceId: 'ws-1',
      threadId: 'pr:owner/repo#12',
      botId: 'bot-1',
      repoKey: 'owner/repo',
      prNumber: 12,
      tainted: false,
      state: 'pending',
      createdAt: 1,
      updatedAt: 1,
      canAlwaysAllow: true,
      ...over,
    },
    ...(botName ? { botName } : {}),
  };
}

describe('buildBotApprovalPushPayload', () => {
  it('★ names the request by botApprovalId, never approvalId, and opens its Bots conversation', () => {
    const payload = buildBotApprovalPushPayload(row());
    expect(payload).toEqual({
      title: 'Approval needed',
      body: 'Reviewer: Merge PR #12 in owner/repo',
      approvalKind: 'bot',
      botApprovalId: 'apr-abcdefgh12',
      workspaceId: 'ws-1',
      threadId: 'pr:owner/repo#12',
      action: 'merge',
      botId: 'bot-1',
      requiresInAppChoice: true,
      risk: 'normal',
    });
    expect('approvalId' in payload).toBe(false);
    expect(botApprovalPushCollapseId('apr-abcdefgh12')).toBe('bot-apr-abcdefgh12');
    // An act no rule may approve rings through presence.
    expect(buildBotApprovalPushPayload(row({ action: 'release', prNumber: undefined }, null))).toMatchObject({
      body: 'A bot: Publish a release of owner/repo',
      risk: 'critical',
    });
    expect(buildBotApprovalPushPayload(row({ action: 'pr_close', prNumber: 12 }, null))).toMatchObject({
      body: 'A bot: Close PR #12 in owner/repo without merging',
      action: 'pr_close',
      risk: 'normal',
    });
  });
});

function harness(suppressed = false) {
  const sent: Array<{ payload: PushPayload; opts: { collapseId: string; requires: string } }> = [];
  const parked: string[] = [];
  const forgotten: string[] = [];
  const router = new BotApprovalPushRouter({
    suppress: () => suppressed,
    send: (payload, opts) => sent.push({ payload, opts }),
    park: (key) => parked.push(key),
    forget: (key) => forgotten.push(key),
  });
  return { router, sent, parked, forgotten };
}

describe('BotApprovalPushRouter', () => {
  it('★ pushes a request once, and retracts it under the same collapse id when it leaves the table', () => {
    const h = harness();
    h.router.set([row()]);
    h.router.set([row()]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].opts).toEqual({ collapseId: 'bot-apr-abcdefgh12', requires: 'botApprovalPush' });

    h.router.set([]);
    expect(h.sent).toHaveLength(2);
    const retraction = h.sent[1];
    expect(retraction.opts).toEqual({ collapseId: 'bot-apr-abcdefgh12', requires: 'botApprovalPush' });
    expect(retraction.payload).toMatchObject({ kind: 'approval_retraction', retractsBotApprovalId: 'apr-abcdefgh12' });
    expect('approvalId' in retraction.payload).toBe(false);
    expect('botApprovalId' in retraction.payload).toBe(false);
  });

  it('a push presence held is forgotten, not retracted, and an evicted one is never retracted', () => {
    const h = harness(true);
    h.router.set([row(), row({ requestId: 'apr-zyxwvuts98' })]);
    expect(h.parked).toEqual(['bot:apr-abcdefgh12', 'bot:apr-zyxwvuts98']);
    h.router.onParkedOutcome('bot:apr-zyxwvuts98', 'dropped');

    h.router.set([]);
    expect(h.forgotten).toEqual(['bot:apr-abcdefgh12']);
    expect(h.sent).toHaveLength(0);
  });
});

describe('BotApprovalPushRouter — the publishing main quits', () => {
  it('★ a held push is forgotten before presence releases it, and the next table pushes it once', () => {
    let present = true;
    const sent: PushPayload[] = [];
    const queue = new DeferredPushQueue({
      send: (payload) => sent.push(payload),
      isPresent: () => present,
      staleAfterMs: () => 60_000,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    const router = new BotApprovalPushRouter({
      suppress: () => present,
      send: (payload) => sent.push(payload),
      park: (key, payload, collapseId, requires) => queue.park(key, payload, collapseId, requires),
      forget: (key) => queue.forget(key),
    });
    router.set([row()]);
    expect(queue.size).toBe(1);

    // The client close handler: the publisher's held pushes go, then presence drops.
    router.forgetParked();
    present = false;
    queue.onPresenceChanged();
    expect(sent).toHaveLength(0);

    // The next main publishes the same table: never delivered, so pushed once.
    router.set([row()]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ botApprovalId: 'apr-abcdefgh12' });
  });
});
