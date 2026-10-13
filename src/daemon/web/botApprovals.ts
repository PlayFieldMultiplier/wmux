// The phone operator's bot approvals (contract: shared/phoneBotApprovals.ts):
//
//   GET  /api/bot-approvals/:requestId
//   POST /api/bot-approvals/:requestId/decision   {decision, ruleScope?}
//
// The requests and every decision are Electron main's. This daemon admits the
// operator token only — a paired device is 403 `operator-only`, checked
// first; a decision on a server started without --allow-input is 403
// `read-only` — then asks main over the desktop bridge and parses its reply with
// the same allowlist main projected with. No desktop, or one that did not
// announce the commands, is 503; nothing here answers from memory.

import {
  PHONE_BOT_APPROVAL_COMMAND,
  PHONE_BOT_APPROVAL_DECIDE_COMMAND,
  isPhoneBotApprovalId,
  parsePhoneBotApprovalDecideBody,
  parsePhoneBotApprovalReply,
} from '../../shared/phoneBotApprovals';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';

export const BOT_APPROVALS_ROUTE = /^\/api\/bot-approvals\/([^/]+)(\/decision)?$/;

/** The part of the desktop bridge the routes use (DesktopPhoneBridge). */
export interface BotApprovalsDesktop {
  supports(command: string): boolean;
  request(command: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface BotApprovalsResponse {
  status: number;
  body: unknown;
}

/** Whether both commands answer on the attached desktop. */
export function botApprovalsSupported(desktop: BotApprovalsDesktop | null): boolean {
  return !!desktop && desktop.supports(PHONE_BOT_APPROVAL_COMMAND) && desktop.supports(PHONE_BOT_APPROVAL_DECIDE_COMMAND);
}

/** `GET /api/bot-approvals/:id` (body undefined) or `POST …/decision`
 *  (the parsed JSON body). Never throws. */
export async function botApprovalsResponse(
  rawId: string,
  view: 'get' | 'decision',
  body: unknown,
  opts: { operator: boolean; desktop: BotApprovalsDesktop | null; readOnly?: boolean },
): Promise<BotApprovalsResponse> {
  if (!opts.operator) return { status: 403, body: { error: 'operator-only' } };
  // A server started without --allow-input takes no decision.
  if (view === 'decision' && opts.readOnly === true) return { status: 403, body: { error: 'read-only' } };
  let requestId: string;
  try {
    requestId = decodeURIComponent(rawId);
  } catch {
    return { status: 404, body: { error: 'approval-not-found' } };
  }
  if (!isPhoneBotApprovalId(requestId)) return { status: 404, body: { error: 'approval-not-found' } };
  let payload: Record<string, unknown> = { requestId };
  if (view === 'decision') {
    const decided = parsePhoneBotApprovalDecideBody(body);
    if (!decided) return { status: 400, body: { error: 'invalid-decision' } };
    payload = { requestId, ...decided };
  }
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!botApprovalsSupported(desktop)) return { status: 503, body: { error: 'approvals-unavailable' } };
  let raw: unknown;
  try {
    raw = await desktop.request(view === 'get' ? PHONE_BOT_APPROVAL_COMMAND : PHONE_BOT_APPROVAL_DECIDE_COMMAND, payload);
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const reply = parsePhoneBotApprovalReply(raw, requestId);
  if (!reply) return { status: 502, body: { error: 'desktop-bad-reply' } };
  if ('unavailable' in reply) return { status: 503, body: { error: 'approvals-unavailable' } };
  if ('notFound' in reply) return { status: 404, body: { error: 'approval-not-found' } };
  if ('invalid' in reply) return { status: 400, body: { error: 'invalid-decision' } };
  if ('refused' in reply) return { status: 409, body: { error: 'approval-refused', code: reply.refused.code, message: reply.refused.message } };
  return { status: 200, body: { request: reply.request } };
}
