import { describe, expect, it } from 'vitest';
import { botApprovalPushRows } from '../BotApprovalPushFeed';
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
