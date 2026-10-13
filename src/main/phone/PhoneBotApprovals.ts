// The phone operator's side of bot approvals in main: read one request, and
// decide it through ApprovalService.decide(…, 'phone') — the same decision
// the desktop card makes. The daemon admits only the operator token before it
// asks (daemon/web/botApprovals.ts); contract in shared/phoneBotApprovals.ts.

import { getApprovalService, type ApprovalService } from '../factory/approvals';
import {
  PHONE_BOT_APPROVAL_COMMAND,
  PHONE_BOT_APPROVAL_DECIDE_COMMAND,
  isPhoneBotApprovalId,
  parsePhoneBotApprovalDecideBody,
  phoneBotApproval,
  type PhoneBotApprovalReply,
} from '../../shared/phoneBotApprovals';

type Approvals = Pick<ApprovalService, 'get' | 'decide'>;

/** `workspaces.botApproval` / `workspaces.botApprovalDecide`; null for any
 *  other command. */
export function handlePhoneBotApprovalCommand(
  command: string,
  payload: Record<string, unknown>,
  approvals: () => Approvals | null = getApprovalService,
): PhoneBotApprovalReply | null {
  if (command !== PHONE_BOT_APPROVAL_COMMAND && command !== PHONE_BOT_APPROVAL_DECIDE_COMMAND) return null;
  const requestId = payload.requestId;
  if (!isPhoneBotApprovalId(requestId)) return { invalid: true };
  const service = approvals();
  if (!service) return { unavailable: true };
  if (command === PHONE_BOT_APPROVAL_COMMAND) {
    const r = service.get(requestId);
    const view = r ? phoneBotApproval(r) : null;
    return view ? { request: view } : { notFound: true };
  }
  const body = parsePhoneBotApprovalDecideBody({ decision: payload.decision, ...(payload.ruleScope !== undefined ? { ruleScope: payload.ruleScope } : {}) });
  if (!body) return { invalid: true };
  const res = service.decide({ requestId, ...body }, 'phone');
  if (!res.ok) return res.code === 'not_found' ? { notFound: true } : { refused: { code: res.code, message: res.message } };
  const view = phoneBotApproval(res.request);
  return view ? { request: view } : { unavailable: true };
}
