// The phone's worker Resume route: the bot-approval decision's caller rule,
// checked again once the body is in; the body and id checks; then main's
// reply mapped to its HTTP answer.
import { describe, it, expect, vi } from 'vitest';
import { WORKER_RESUME_ROUTE, workerResumeResponse, workerResumeSupported } from '../workerResume';
import type { BotApprovalsCaller, BotApprovalsDesktop } from '../botApprovals';
import { DesktopPhoneError } from '../../phone/DesktopPhoneBridge';

const NOW = 1_760_900_000_000;
const TASK = 'wtask-abc-12345678';
const RID = `${NOW}-0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d`;
const BODY = { clientRequestId: RID };
const OPERATOR: BotApprovalsCaller = { kind: 'operator' };
const GRANTED: BotApprovalsCaller = { kind: 'device', deviceId: 'd1', mayInput: true, explicitInputGrant: true };
const LEGACY: BotApprovalsCaller = { kind: 'device', deviceId: 'd2', mayInput: true, explicitInputGrant: false };
const VIEWER: BotApprovalsCaller = { kind: 'device', deviceId: 'd3', mayInput: false, explicitInputGrant: false };
const RESUMED = { resumed: { taskId: TASK, workspaceId: 'ws-task', sessionId: 'daemon-1' } };

function desktop(reply: unknown | Error, supports = true): BotApprovalsDesktop & { request: ReturnType<typeof vi.fn> } {
  return {
    supports: () => supports,
    request: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}
const as = (caller: BotApprovalsCaller, d: BotApprovalsDesktop | null, readOnly = false) => ({ caller, reauthorize: async () => caller, desktop: d, readOnly, now: () => NOW });

describe('POST /api/bot-tasks/:taskId/resume', () => {
  it('matches the resume path only', () => {
    expect(WORKER_RESUME_ROUTE.exec(`/api/bot-tasks/${TASK}/resume`)?.[1]).toBe(TASK);
    expect(WORKER_RESUME_ROUTE.exec(`/api/bot-tasks/${TASK}`)).toBeNull();
    expect(workerResumeSupported(desktop(RESUMED, false))).toBe(false);
    expect(workerResumeSupported(null)).toBe(false);
  });

  it('takes the operator or a device whose input grant was set explicitly, on a server that takes input', async () => {
    const d = desktop(RESUMED);
    expect(await workerResumeResponse(TASK, BODY, as(OPERATOR, d, true))).toEqual({ status: 403, body: { error: 'read-only' } });
    expect(await workerResumeResponse(TASK, BODY, as(LEGACY, d))).toMatchObject({ status: 403, body: { error: 'read-only: this device has no explicit input grant' } });
    expect(await workerResumeResponse(TASK, BODY, as(VIEWER, d))).toMatchObject({ status: 403, body: { error: 'read-only: this device was paired without permission to type' } });
    // The credential no longer resolves to the same caller once the body is in.
    expect(await workerResumeResponse(TASK, BODY, { ...as(GRANTED, d), reauthorize: async () => null })).toEqual({ status: 401, body: { error: 'authorization-expired' } });
    expect(await workerResumeResponse(TASK, BODY, { ...as(GRANTED, d), reauthorize: async () => ({ ...GRANTED, deviceId: 'd9' }) })).toEqual({ status: 401, body: { error: 'authorization-expired' } });
    // Its grant was taken away meanwhile.
    expect((await workerResumeResponse(TASK, BODY, { ...as(GRANTED, d), reauthorize: async () => ({ ...GRANTED, mayInput: false }) })).status).toBe(403);
    expect(d.request).not.toHaveBeenCalled();

    expect(await workerResumeResponse(TASK, BODY, as(GRANTED, d))).toEqual({
      status: 200, body: { state: 'resumed', taskId: TASK, workspaceId: 'ws-task', sessionId: 'daemon-1', clientRequestId: RID, replayed: false },
    });
    // Main is told which device asked; the operator sends none.
    expect(d.request).toHaveBeenLastCalledWith('workspaces.workerResume', { taskId: TASK, clientRequestId: RID, deviceId: 'd1' });
    await workerResumeResponse(TASK, BODY, as(OPERATOR, d));
    expect(d.request).toHaveBeenLastCalledWith('workspaces.workerResume', { taskId: TASK, clientRequestId: RID });
  });

  it('refuses a malformed task, body or request id before the desktop is asked', async () => {
    const d = desktop(RESUMED);
    expect(await workerResumeResponse('nope', BODY, as(OPERATOR, d))).toEqual({ status: 404, body: { error: 'task-not-found' } });
    expect(await workerResumeResponse('%E0', BODY, as(OPERATOR, d))).toEqual({ status: 404, body: { error: 'task-not-found' } });
    for (const body of [null, [], {}, { clientRequestId: RID, extra: 1 }, { clientRequestId: 'x' }, { clientRequestId: `${NOW - 11 * 60_000}-0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d` }]) {
      expect(await workerResumeResponse(TASK, body, as(OPERATOR, d))).toMatchObject({ status: 400, body: { error: 'invalid-resume-request' } });
    }
    expect(d.request).not.toHaveBeenCalled();
  });

  it('maps every reply of main to its answer', async () => {
    const answer = (reply: unknown) => workerResumeResponse(TASK, BODY, as(OPERATOR, desktop(reply)));
    expect(await answer({ ...RESUMED, replayed: true })).toMatchObject({ status: 200, body: { state: 'resumed', replayed: true } });
    expect(await answer({ notFound: true })).toEqual({ status: 404, body: { error: 'task-not-found' } });
    expect(await answer({ invalid: true })).toEqual({ status: 400, body: { error: 'invalid-resume-request' } });
    expect(await answer({ unavailable: true })).toEqual({ status: 503, body: { error: 'resume-unavailable' } });
    expect(await answer({ idReused: true })).toEqual({ status: 409, body: { error: 'request-id-reused' } });
    expect(await answer({ full: true })).toEqual({ status: 429, body: { error: 'resume-busy' } });
    for (const code of ['already_running', 'not_reclaimed', 'no_conversation', 'pane_gone', 'worktree_gone', 'moved', 'unknown_state', 'not_typed', 'not_reopened', 'not_now']) {
      expect(await answer({ refused: { code, message: 'm' } })).toEqual({ status: 409, body: { error: 'resume-refused', code, message: 'm' } });
    }
    expect(await answer({ refused: { code: 'no_slot', message: 'm', cap: 3 } })).toEqual({ status: 409, body: { error: 'resume-refused', code: 'no_slot', message: 'm', cap: 3 } });
    expect(await answer({ refused: { code: 'busy', message: 'm' } })).toEqual({ status: 409, body: { error: 'resume-refused', code: 'busy', message: 'm' }, headers: { 'Retry-After': '5' } });
    // A reply for another task, or not a reply at all.
    expect(await answer({ resumed: { ...RESUMED.resumed, taskId: 'wtask-other' } })).toEqual({ status: 502, body: { error: 'desktop-bad-reply' } });
    expect(await answer({ refused: { code: 'Bad Code', message: 'm' } })).toEqual({ status: 502, body: { error: 'desktop-bad-reply' } });
  });

  it('no desktop, a desktop without the command, and a desktop that does not answer', async () => {
    expect(await workerResumeResponse(TASK, BODY, as(OPERATOR, null))).toEqual({ status: 503, body: { error: 'desktop-unavailable' } });
    expect(await workerResumeResponse(TASK, BODY, as(OPERATOR, desktop(RESUMED, false)))).toEqual({ status: 503, body: { error: 'resume-unavailable' } });
    expect(await workerResumeResponse(TASK, BODY, as(OPERATOR, desktop(new DesktopPhoneError('desktop-timeout'))))).toEqual({ status: 504, body: { error: 'desktop-timeout' } });
    expect(await workerResumeResponse(TASK, BODY, as(OPERATOR, desktop(new Error('gone'))))).toEqual({ status: 503, body: { error: 'desktop-unavailable' } });
  });
});
