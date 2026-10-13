// The phone operator's bot-approval routes: the operator token only, then
// main's reply through the same allowlist main projected with.
import { describe, it, expect, vi } from 'vitest';
import { botApprovalsResponse, botApprovalsSupported, BOT_APPROVALS_ROUTE, type BotApprovalsDesktop } from '../botApprovals';
import { DesktopPhoneError } from '../../phone/DesktopPhoneBridge';
import { parsePhoneBotApproval, parsePhoneBotApprovalDecideBody } from '../../../shared/phoneBotApprovals';
import { parsePhoneRoomCard } from '../../../shared/phoneRooms';

const ID = 'apr-aaaaaaaa1';
const VIEW = {
  requestId: ID, action: 'merge', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', repoKey: 'github.com/o/r', prNumber: 3, headSha: 'a'.repeat(40),
  tainted: false, state: 'pending', createdAt: 1, updatedAt: 1, canAlwaysAllow: true,
};

function desktop(reply: unknown | Error, supports = true): BotApprovalsDesktop & { request: ReturnType<typeof vi.fn> } {
  return {
    supports: () => supports,
    request: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

describe('/api/bot-approvals', () => {
  it('matches the read and the decision path only', () => {
    expect(BOT_APPROVALS_ROUTE.exec(`/api/bot-approvals/${ID}`)?.[2]).toBeUndefined();
    expect(BOT_APPROVALS_ROUTE.exec(`/api/bot-approvals/${ID}/decision`)?.[2]).toBe('/decision');
    expect(BOT_APPROVALS_ROUTE.exec(`/api/bot-approvals/${ID}/other`)).toBeNull();
  });

  it('a paired device is refused before anything is asked; a read-only server takes no decision', async () => {
    const d = desktop({ request: VIEW });
    expect(await botApprovalsResponse(ID, 'get', undefined, { operator: false, desktop: d })).toEqual({ status: 403, body: { error: 'operator-only' } });
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { operator: false, desktop: d })).toEqual({ status: 403, body: { error: 'operator-only' } });
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { operator: true, desktop: d, readOnly: true })).toEqual({ status: 403, body: { error: 'read-only' } });
    expect(d.request).not.toHaveBeenCalled();
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: d, readOnly: true })).status).toBe(200);
  });

  it('the operator reads and decides through main', async () => {
    const d = desktop({ request: VIEW });
    expect(await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: d })).toEqual({ status: 200, body: { request: VIEW } });
    expect(d.request).toHaveBeenLastCalledWith('workspaces.botApproval', { requestId: ID });
    const approved = { ...VIEW, state: 'approved', decidedBy: 'owner', decidedAt: 5, executeAfter: 10_005, canAlwaysAllow: false };
    const d2 = desktop({ request: approved });
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'always', ruleScope: 'workspace' }, { operator: true, desktop: d2 })).toEqual({ status: 200, body: { request: approved } });
    expect(d2.request).toHaveBeenLastCalledWith('workspaces.botApprovalDecide', { requestId: ID, decision: 'always', ruleScope: 'workspace' });
  });

  it('maps a bad id, body, refusal, missing desktop and bad reply', async () => {
    const ok = desktop({ request: VIEW });
    expect((await botApprovalsResponse('nope', 'get', undefined, { operator: true, desktop: ok })).status).toBe(404);
    expect((await botApprovalsResponse(ID, 'decision', { decision: 'merge' }, { operator: true, desktop: ok })).status).toBe(400);
    expect((await botApprovalsResponse(ID, 'decision', { decision: 'approve', extra: 1 }, { operator: true, desktop: ok })).status).toBe(400);
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { operator: true, desktop: desktop({ refused: { code: 'not_pending', message: 'the request is denied' } }) }))
      .toEqual({ status: 409, body: { error: 'approval-refused', code: 'not_pending', message: 'the request is denied' } });
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: desktop({ notFound: true }) })).status).toBe(404);
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: desktop({ unavailable: true }) })).status).toBe(503);
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: null })).status).toBe(503);
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: desktop({ request: VIEW }, false) })).body).toEqual({ error: 'approvals-unavailable' });
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: desktop(new DesktopPhoneError('desktop-timeout')) })).status).toBe(504);
    expect((await botApprovalsResponse(ID, 'get', undefined, { operator: true, desktop: desktop({ request: { ...VIEW, requestId: 'apr-bbbbbbbb2' } }) })).status).toBe(502);
    expect(botApprovalsSupported(null)).toBe(false);
  });

  it('the view keeps only its allowlist; the body takes ruleScope only with always', () => {
    expect(parsePhoneBotApproval({ ...VIEW, reason: 'bot words', repoPath: '/repo', ghLogin: 'me' })).toEqual(VIEW);
    expect(parsePhoneBotApproval({ ...VIEW, tainted: undefined })?.tainted).toBe(true);
    expect(parsePhoneBotApproval({ ...VIEW, action: 'release', canAlwaysAllow: true })?.canAlwaysAllow).toBe(false);
    expect(parsePhoneBotApprovalDecideBody({ decision: 'approve', ruleScope: 'bot' })).toBeNull();
    expect(parsePhoneBotApprovalDecideBody({ decision: 'always' })).toEqual({ decision: 'always' });
  });

  it('an approval card reaches the phone with its request id', () => {
    const card = parsePhoneRoomCard({ id: 'c1', seq: 1, threadId: 'general', kind: 'approval', at: 1, actor: { kind: 'system' }, title: 'Merge PR #3?', refs: { approvalId: ID, pr: 3 } });
    expect(card).toMatchObject({ kind: 'approval', refs: { approvalId: ID, pr: 3 } });
    expect(parsePhoneRoomCard({ id: 'c1', seq: 1, threadId: 'general', kind: 'approval', at: 1, actor: { kind: 'system' }, title: 'x', refs: { approvalId: 'x y' } })?.refs).toBeUndefined();
  });
});
