// The phone's bot-approval routes: any caller reads; a decision takes the
// operator or a device with an explicit input grant, checked again on the
// credential when the body is in; then main's reply through the same
// allowlist main projected with.
import { describe, it, expect, vi } from 'vitest';
import {
  botApprovalDecisionRefusal, botApprovalsResponse, botApprovalsSupported, BOT_APPROVALS_ROUTE,
  type BotApprovalsCaller, type BotApprovalsDesktop,
} from '../botApprovals';
import { DesktopPhoneError } from '../../phone/DesktopPhoneBridge';
import { parsePhoneBotApproval, parsePhoneBotApprovalDecideBody } from '../../../shared/phoneBotApprovals';
import { parsePhoneRoomCard } from '../../../shared/phoneRooms';

const ID = 'apr-aaaaaaaa1';
const VIEW = {
  requestId: ID, action: 'merge', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', repoKey: 'github.com/o/r', prNumber: 3, headSha: 'a'.repeat(40),
  tainted: false, state: 'pending', createdAt: 1, updatedAt: 1, canAlwaysAllow: true,
};

const OPERATOR: BotApprovalsCaller = { kind: 'operator' };
const GRANTED: BotApprovalsCaller = { kind: 'device', deviceId: 'd1', mayInput: true, explicitInputGrant: true };
/** Paired before grants existed: it may type, but its grant was never set. */
const LEGACY: BotApprovalsCaller = { kind: 'device', deviceId: 'd2', mayInput: true, explicitInputGrant: false };
const VIEWER: BotApprovalsCaller = { kind: 'device', deviceId: 'd3', mayInput: false, explicitInputGrant: false };
/** The operator, unchanged when the body is in. */
const op = { caller: OPERATOR, reauthorize: async () => OPERATOR };

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

  it('any caller reads; a read-only server takes no decision', async () => {
    const d = desktop({ request: VIEW });
    for (const caller of [OPERATOR, GRANTED, LEGACY, VIEWER]) {
      expect(await botApprovalsResponse(ID, 'get', undefined, { caller, desktop: d, readOnly: true })).toEqual({ status: 200, body: { request: VIEW } });
    }
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { ...op, desktop: d, readOnly: true })).toEqual({ status: 403, body: { error: 'read-only' } });
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { caller: GRANTED, reauthorize: async () => GRANTED, desktop: d, readOnly: true }))
      .toEqual({ status: 403, body: { error: 'read-only' } });
    expect(d.request).not.toHaveBeenCalledWith('workspaces.botApprovalDecide', expect.anything());
  });

  it('a decision takes the operator or a device whose input grant was set explicitly', async () => {
    expect(botApprovalDecisionRefusal(OPERATOR, false)).toBeNull();
    expect(botApprovalDecisionRefusal(GRANTED, false)).toBeNull();
    expect(botApprovalDecisionRefusal(LEGACY, false)).toMatchObject({ status: 403, body: { error: 'read-only: this device has no explicit input grant' } });
    expect(botApprovalDecisionRefusal(VIEWER, false)).toMatchObject({ status: 403, body: { error: 'read-only: this device was paired without permission to type' } });
    expect(botApprovalDecisionRefusal(GRANTED, true)).toEqual({ status: 403, body: { error: 'read-only' } });

    const d = desktop({ request: VIEW });
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'deny' }, { caller: GRANTED, reauthorize: async () => GRANTED, desktop: d }))
      .toEqual({ status: 200, body: { request: VIEW } });
    // Main is told which device decided; the operator sends no device.
    expect(d.request).toHaveBeenLastCalledWith('workspaces.botApprovalDecide', { requestId: ID, decision: 'deny', deviceId: 'd1' });
    for (const caller of [LEGACY, VIEWER]) {
      const refused = desktop({ request: VIEW });
      expect((await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { caller, reauthorize: async () => caller, desktop: refused })).status).toBe(403);
      expect(refused.request).not.toHaveBeenCalled();
    }
  });

  it('the credential is checked again once the body is in: the same caller, still granted', async () => {
    const asks = async (reauthorize: (() => Promise<BotApprovalsCaller | null>) | undefined, caller: BotApprovalsCaller = GRANTED) => {
      const d = desktop({ request: VIEW });
      const r = await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { caller, desktop: d, ...(reauthorize ? { reauthorize } : {}) });
      return { r, asked: d.request.mock.calls.some(([c]) => c === 'workspaces.botApprovalDecide') };
    };
    // Revoked (or no longer authenticating) while the body was read.
    expect(await asks(async () => null)).toEqual({ r: { status: 401, body: { error: 'authorization-expired' } }, asked: false });
    // Another device, or the operator token, on the same request.
    expect((await asks(async () => ({ ...GRANTED, deviceId: 'd9' }))).r.status).toBe(401);
    expect((await asks(async () => OPERATOR)).r.status).toBe(401);
    expect((await asks(async () => GRANTED, OPERATOR)).r.status).toBe(401);
    // The grant was taken away, or the check threw: refused, main not asked.
    expect(await asks(async () => ({ ...GRANTED, explicitInputGrant: false }))).toMatchObject({ r: { status: 403 }, asked: false });
    expect(await asks(async () => { throw new Error('boom'); })).toMatchObject({ r: { status: 401 }, asked: false });
    // No re-check wired: refused.
    expect(await asks(undefined)).toMatchObject({ r: { status: 401 }, asked: false });
  });

  it('maps a bad id, body, refusal, missing desktop and bad reply', async () => {
    const ok = desktop({ request: VIEW });
    expect((await botApprovalsResponse('nope', 'get', undefined, { ...op, desktop: ok })).status).toBe(404);
    expect((await botApprovalsResponse(ID, 'decision', { decision: 'merge' }, { ...op, desktop: ok })).status).toBe(400);
    expect((await botApprovalsResponse(ID, 'decision', { decision: 'approve', extra: 1 }, { ...op, desktop: ok })).status).toBe(400);
    expect(await botApprovalsResponse(ID, 'decision', { decision: 'approve' }, { ...op, desktop: desktop({ refused: { code: 'not_pending', message: 'the request is denied' } }) }))
      .toEqual({ status: 409, body: { error: 'approval-refused', code: 'not_pending', message: 'the request is denied' } });
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: desktop({ notFound: true }) })).status).toBe(404);
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: desktop({ unavailable: true }) })).status).toBe(503);
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: null })).status).toBe(503);
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: desktop({ request: VIEW }, false) })).body).toEqual({ error: 'approvals-unavailable' });
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: desktop(new DesktopPhoneError('desktop-timeout')) })).status).toBe(504);
    expect((await botApprovalsResponse(ID, 'get', undefined, { ...op, desktop: desktop({ request: { ...VIEW, requestId: 'apr-bbbbbbbb2' } }) })).status).toBe(502);
    expect(botApprovalsSupported(null)).toBe(false);
  });

  it('the view keeps only its allowlist; the body takes ruleScope only with always', () => {
    expect(parsePhoneBotApproval({ ...VIEW, reason: 'bot words', repoPath: '/repo', ghLogin: 'me' })).toEqual(VIEW);
    expect(parsePhoneBotApproval({ ...VIEW, tainted: undefined })?.tainted).toBe(true);
    expect(parsePhoneBotApproval({ ...VIEW, action: 'release', canAlwaysAllow: true })?.canAlwaysAllow).toBe(false);
    expect(parsePhoneBotApprovalDecideBody({ decision: 'approve', ruleScope: 'bot' })).toBeNull();
    expect(parsePhoneBotApprovalDecideBody({ decision: 'always' })).toEqual({ decision: 'always' });
  });

  it('an act\'s view carries its payloadHash; an approval may echo it, nothing else may carry one', () => {
    const hash = 'a'.repeat(64);
    expect(parsePhoneBotApproval({ ...VIEW, action: 'pr_close', payloadHash: hash })).toMatchObject({ action: 'pr_close', payloadHash: hash, canAlwaysAllow: false });
    expect(parsePhoneBotApproval({ ...VIEW, action: 'comment', payloadHash: 'not-a-hash' })?.payloadHash).toBeUndefined();
    expect(parsePhoneBotApprovalDecideBody({ decision: 'approve', payloadHash: hash })).toEqual({ decision: 'approve', payloadHash: hash });
    expect(parsePhoneBotApprovalDecideBody({ decision: 'approve', payloadHash: 'A'.repeat(64) })).toBeNull();
    expect(parsePhoneBotApprovalDecideBody({ decision: 'deny', payloadHash: hash })).toBeNull();
  });

  it('an approval card reaches the phone with its request id', () => {
    const card = parsePhoneRoomCard({ id: 'c1', seq: 1, threadId: 'general', kind: 'approval', at: 1, actor: { kind: 'system' }, title: 'Merge PR #3?', refs: { approvalId: ID, pr: 3 } });
    expect(card).toMatchObject({ kind: 'approval', refs: { approvalId: ID, pr: 3 } });
    expect(parsePhoneRoomCard({ id: 'c1', seq: 1, threadId: 'general', kind: 'approval', at: 1, actor: { kind: 'system' }, title: 'x', refs: { approvalId: 'x y' } })?.refs).toBeUndefined();
  });
});
