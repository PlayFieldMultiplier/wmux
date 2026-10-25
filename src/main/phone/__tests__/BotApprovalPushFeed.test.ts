import { describe, expect, it } from 'vitest';
import { botApprovalPushRows, botApprovalPushTable, createBotApprovalPushFeed } from '../BotApprovalPushFeed';
import { parseBotApprovalPushRows } from '../../../shared/botApprovalPush';
import type { ApprovalView } from '../../factory/approvals';

function view(requestId: string, over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    requestId,
    action: 'merge',
    repoKey: 'owner/repo',
    prNumber: 12,
    botId: 'bot-1',
    workspaceId: 'ws-1',
    threadId: 'pr:owner/repo#12',
    reason: 'ready',
    tainted: false,
    state: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as ApprovalView;
}

describe('botApprovalPushRows', () => {
  it('★ sends only pending requests whose act the phone may decide, with the bot\'s name', () => {
    const rows = botApprovalPushRows(
      [
        view('apr-merge00001'),
        view('apr-skill00001', { action: 'skill', repoKey: '' }),
        view('apr-native0001', { action: 'native_tool', repoKey: '' }),
        view('apr-denied0001', { state: 'denied' }),
      ],
      (botId) => (botId === 'bot-1' ? 'Reviewer' : undefined),
    );
    expect(rows.map((r) => r.request.requestId)).toEqual(['apr-merge00001']);
    expect(rows[0].botName).toBe('Reviewer');
    // The daemon parses with the same filter, so a card-only act sent anyway
    // is dropped there too.
    expect(parseBotApprovalPushRows([{ request: { ...rows[0].request, action: 'skill' } }, rows[0]])).toEqual(rows);
  });
});

describe('createBotApprovalPushFeed', () => {
  it('★ sends nothing before the approval store starts, then the store\'s table once, never an empty one', async () => {
    const timers: Array<() => void> = [];
    let requests: ApprovalView[] | null = null;
    const pushes: unknown[][] = [];
    const feed = createBotApprovalPushFeed({
      rows: () => botApprovalPushTable(requests, () => 'Reviewer'),
      push: async (rows) => { pushes.push(rows); },
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => undefined,
    });

    // A daemon connect that comes before the store has loaded.
    feed.publishNow();
    expect(pushes).toEqual([]);

    // The store starts with a request kept from the last run.
    requests = [view('apr-merge00001')];
    feed.schedule();
    timers.shift()?.();
    await Promise.resolve();
    expect(pushes).toHaveLength(1);
    expect((pushes[0] as Array<{ request: { requestId: string } }>).map((r) => r.request.requestId)).toEqual(['apr-merge00001']);
  });
});
