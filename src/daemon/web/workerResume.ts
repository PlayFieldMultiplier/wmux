// A stopped bot worker's Resume from the phone (contract:
// shared/phoneWorkerResume.ts):
//
//   POST /api/bot-tasks/:taskId/resume   {clientRequestId}
//
// The resume is Electron main's, the same one the desktop's Resume button
// runs. The caller is admitted as for a bot approval's decision
// (botApprovals.ts): the operator token, or a paired device that holds the
// input grant AND had it set explicitly, on a server started with
// --allow-input. That is checked before the body is read, and again on the
// credential presented once the body is in, just before main is asked: it
// must be the same caller (the same device), still granted. Main keeps the
// receipts (a repeat of the same request id never starts a second worker);
// the request id's format and window are checked here first as well. No
// desktop, or one that did not announce the command, is 503.

import { checkChatId } from '../chat/chatBridge';
import { DesktopPhoneError } from '../phone/DesktopPhoneBridge';
import {
  PHONE_WORKER_RESUME_COMMAND,
  PHONE_WORKER_RESUME_WINDOW_MS,
  isPhoneWorkerTaskId,
  parsePhoneWorkerResumeBody,
  parsePhoneWorkerResumeReply,
} from '../../shared/phoneWorkerResume';
import { GRANT_HINT, botApprovalDecisionRefusal, type BotApprovalsCaller, type BotApprovalsDesktop, type BotApprovalsResponse } from './botApprovals';

export const WORKER_RESUME_ROUTE = /^\/api\/bot-tasks\/([^/]+)\/resume$/;

export interface WorkerResumeResponse extends BotApprovalsResponse {
  headers?: Record<string, string>;
}

/** Whether the attached desktop takes the command. */
export function workerResumeSupported(desktop: BotApprovalsDesktop | null): boolean {
  return !!desktop && desktop.supports(PHONE_WORKER_RESUME_COMMAND);
}

/** Why this caller may not resume a worker, or null when it may: the rule
 *  of a bot approval's decision, with the same errors. */
export function workerResumeRefusal(caller: BotApprovalsCaller, readOnly: boolean): WorkerResumeResponse | null {
  const refused = botApprovalDecisionRefusal(caller, readOnly);
  if (!refused || caller.kind !== 'device' || readOnly) return refused;
  const detail = caller.mayInput
    ? `Resuming a worker needs an input grant set for this device. ${GRANT_HINT}`
    : `Resuming a worker requires input permission. ${GRANT_HINT}`;
  return { status: refused.status, body: { ...(refused.body as Record<string, unknown>), detail } };
}

/** `POST /api/bot-tasks/:taskId/resume` with the parsed JSON body. Never throws. */
export async function workerResumeResponse(
  rawTaskId: string,
  body: unknown,
  opts: {
    caller: BotApprovalsCaller;
    desktop: BotApprovalsDesktop | null;
    readOnly?: boolean;
    /** The caller the credential on this request resolves to now, or null
     *  when it no longer authenticates as the same caller. Asked once the
     *  body is in, before main is. Missing: refused. */
    reauthorize?: () => Promise<BotApprovalsCaller | null>;
    now?: () => number;
  },
): Promise<WorkerResumeResponse> {
  const refused = workerResumeRefusal(opts.caller, opts.readOnly === true);
  if (refused) return refused;
  let now: BotApprovalsCaller | null = null;
  try {
    now = opts.reauthorize ? await opts.reauthorize() : null;
  } catch {
    now = null;
  }
  const same = !!now && (now.kind === 'operator' ? opts.caller.kind === 'operator' : opts.caller.kind === 'device' && now.deviceId === opts.caller.deviceId);
  if (!now || !same) return { status: 401, body: { error: 'authorization-expired' } };
  const again = workerResumeRefusal(now, opts.readOnly === true);
  if (again) return again;
  let taskId: string;
  try {
    taskId = decodeURIComponent(rawTaskId);
  } catch {
    return { status: 404, body: { error: 'task-not-found' } };
  }
  if (!isPhoneWorkerTaskId(taskId)) return { status: 404, body: { error: 'task-not-found' } };
  const parsed = parsePhoneWorkerResumeBody(body);
  if (!parsed) return { status: 400, body: { error: 'invalid-resume-request', detail: 'the body is {clientRequestId} and nothing else' } };
  const { clientRequestId } = parsed;
  const idCheck = checkChatId(clientRequestId, (opts.now ?? Date.now)(), PHONE_WORKER_RESUME_WINDOW_MS);
  if (idCheck !== 'ok') {
    return { status: 400, body: { error: 'invalid-resume-request', detail: idCheck === 'expired' ? 'clientRequestId is outside its time window; send a new one' : 'clientRequestId must be <13-digit ms>-<lowercase uuid>' } };
  }
  const desktop = opts.desktop;
  if (!desktop) return { status: 503, body: { error: 'desktop-unavailable' } };
  if (!workerResumeSupported(desktop)) return { status: 503, body: { error: 'resume-unavailable' } };
  let raw: unknown;
  try {
    raw = await desktop.request(PHONE_WORKER_RESUME_COMMAND, { taskId, clientRequestId, ...(now.kind === 'device' ? { deviceId: now.deviceId } : {}) });
  } catch (error) {
    return error instanceof DesktopPhoneError && error.tag === 'desktop-timeout'
      ? { status: 504, body: { error: 'desktop-timeout' } }
      : { status: 503, body: { error: 'desktop-unavailable' } };
  }
  const reply = parsePhoneWorkerResumeReply(raw, taskId);
  if (!reply) return { status: 502, body: { error: 'desktop-bad-reply' } };
  if ('notFound' in reply) return { status: 404, body: { error: 'task-not-found' } };
  if ('invalid' in reply) return { status: 400, body: { error: 'invalid-resume-request' } };
  if ('unavailable' in reply) return { status: 503, body: { error: 'resume-unavailable' } };
  if ('idReused' in reply) return { status: 409, body: { error: 'request-id-reused' } };
  if ('full' in reply) return { status: 429, body: { error: 'resume-busy' } };
  if ('refused' in reply) {
    return {
      status: 409,
      body: { error: 'resume-refused', ...reply.refused },
      ...(reply.refused.code === 'busy' ? { headers: { 'Retry-After': '5' } } : {}),
    };
  }
  return { status: 200, body: { state: 'resumed', ...reply.resumed, clientRequestId, replayed: reply.replayed === true } };
}
