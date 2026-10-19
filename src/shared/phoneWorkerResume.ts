// ─── Resume a stopped bot worker from the phone
//
//   POST /api/bot-tasks/:taskId/resume   {clientRequestId} → 200 {state:"resumed", …}
//
// The resume is Electron main's: the daemon gates the caller (the rule of
// a bot approval's decision: daemon/web/botApprovals.ts), asks main over the
// desktop bridge with the command below, and parses main's reply with this
// allowlist. Main runs the owner's resume, the one the desktop's Resume
// button runs (factory/workerReclaim.ts ownerResumeWorker), and keeps a
// receipt per caller and request id, so a repeat never starts a second
// worker (main/phone/PhoneWorkerResume.ts).
//
// Room cards: a resumable worker card's `refs.taskId` is the task these
// routes take, and `resumable: true` says its worker can resume now
// (shared/phoneRooms.ts).

export const PHONE_WORKER_RESUME_COMMAND = 'workspaces.workerResume';

/** How long a request id is accepted (from its own time prefix) and its
 *  receipt kept. */
export const PHONE_WORKER_RESUME_WINDOW_MS = 10 * 60 * 1000;

/** A bot task's ledger id. */
const TASK_ID_RE = /^wtask-[A-Za-z0-9_-]{1,80}$/;
const CODE_RE = /^[a-z][a-z_]{0,39}$/;
const LINE_MAX = 300;

export function isPhoneWorkerTaskId(v: unknown): v is string {
  return typeof v === 'string' && TASK_ID_RE.test(v);
}

/** The worker a resume started. */
export interface PhoneWorkerResumed {
  taskId: string;
  /** The workspace the worker runs in (a new one when its pane was closed). */
  workspaceId: string;
  /** The worker's pane. */
  sessionId: string;
}

/** Main's reply to the command. */
export type PhoneWorkerResumeReply =
  | { resumed: PhoneWorkerResumed; replayed?: true }
  | { refused: { code: string; message: string; cap?: number } }
  | { notFound: true }
  | { invalid: true }
  | { unavailable: true }
  | { idReused: true }
  | { full: true };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function line(v: unknown, max = LINE_MAX): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return undefined;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return undefined;
  }
  return v;
}

/** The request body's id, or null when the body is not `{clientRequestId}`
 *  (unknown fields refused). The id's format and window are checked by the
 *  caller (checkChatId). */
export function parsePhoneWorkerResumeBody(value: unknown): { clientRequestId: string } | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((k) => k !== 'clientRequestId')) return null;
  return typeof value.clientRequestId === 'string' ? { clientRequestId: value.clientRequestId } : null;
}

/** Main's reply as the daemon accepts it, or null (a bad reply). */
export function parsePhoneWorkerResumeReply(value: unknown, taskId: string): PhoneWorkerResumeReply | null {
  if (!isRecord(value)) return null;
  if (value.notFound === true) return { notFound: true };
  if (value.invalid === true) return { invalid: true };
  if (value.unavailable === true) return { unavailable: true };
  if (value.idReused === true) return { idReused: true };
  if (value.full === true) return { full: true };
  if (isRecord(value.refused)) {
    const code = typeof value.refused.code === 'string' && CODE_RE.test(value.refused.code) ? value.refused.code : undefined;
    if (!code) return null;
    const cap = value.refused.cap;
    return { refused: { code, message: line(value.refused.message) ?? '', ...(typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0 ? { cap } : {}) } };
  }
  if (!isRecord(value.resumed)) return null;
  const workspaceId = line(value.resumed.workspaceId, 128);
  const sessionId = line(value.resumed.sessionId, 128);
  if (value.resumed.taskId !== taskId || !workspaceId || !sessionId) return null;
  return { resumed: { taskId, workspaceId, sessionId }, ...(value.replayed === true ? { replayed: true as const } : {}) };
}
