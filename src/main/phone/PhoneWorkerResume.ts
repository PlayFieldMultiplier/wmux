// The phone's side of a worker's Resume in main: `workspaces.workerResume`
// runs ownerResumeWorker, the resume the desktop's Resume button runs, once
// the daemon admitted the caller (the operator token, or a paired device with
// an explicit input grant, whose id it sends along: daemon/web/workerResume.ts).
// Contract in shared/phoneWorkerResume.ts.
//
// Receipts are kept here, in memory, by caller and request id: the daemon's
// bridge gives up after 15 s while a resume that reopens a pane may still
// run, so only main knows how a request ended. A repeat joins the request
// under way or replays its success; a refusal is not kept, so a repeat runs
// the checks again. An id is accepted only within its own
// time window, the same as its receipt's life, so a forgotten receipt never
// starts a second worker.

import { chatIdTime, checkChatId } from '../../daemon/chat/chatBridge';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { getWorkerResumePorts, ownerResumeWorker, type WorkerResumeResult } from '../factory/workerReclaim';
import {
  PHONE_WORKER_RESUME_COMMAND,
  PHONE_WORKER_RESUME_WINDOW_MS,
  isPhoneWorkerTaskId,
  type PhoneWorkerResumeReply,
} from '../../shared/phoneWorkerResume';

/** A paired device's id as the daemon sends it. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Requests one desktop keeps receipts for at once; far above any honest load. */
export const PHONE_WORKER_RESUME_RECEIPTS_MAX = 256;
/** A second layer over the resume's own bounded steps (each daemon, renderer
 *  and git call has its own timeout, but they add up): past this the receipt
 *  settles, so a repeat is never held by it. The resume itself goes on and
 *  keeps its task's lock, so a repeat then answers busy or already_running. */
export const PHONE_WORKER_RESUME_WAIT_MS = 60_000;

export interface PhoneWorkerResumeDeps {
  /** The owner's resume (ownerResumeWorker). */
  resume(taskId: string): Promise<WorkerResumeResult>;
  /** The task has a ledger row or a reclaim record. */
  taskKnown(taskId: string): boolean;
  now(): number;
  log(line: string): void;
  /** How long main waits for the resume (PHONE_WORKER_RESUME_WAIT_MS). */
  waitMs?: number;
}

function defaultDeps(): PhoneWorkerResumeDeps {
  return {
    resume: (taskId) => ownerResumeWorker(taskId),
    taskKnown: (taskId) => getTaskLedger().get(taskId) !== null || !!getWorkerResumePorts()?.store.get(taskId),
    now: () => Date.now(),
    log: (line) => console.log(line),
  };
}

interface Receipt {
  taskId: string;
  expiresAt: number;
  /** The request under way. */
  pending?: Promise<PhoneWorkerResumeReply>;
  /** A success, replayed to a repeat. */
  done?: PhoneWorkerResumeReply;
}

const receipts = new Map<string, Receipt>();

/** Tests only. */
export function clearPhoneWorkerResumeReceipts(): void {
  receipts.clear();
}

function replyOf(r: WorkerResumeResult): PhoneWorkerResumeReply {
  if (r.ok) return { resumed: { taskId: r.taskId, workspaceId: r.workspaceId, sessionId: r.sessionId } };
  if (r.code === 'not_started') return { unavailable: true };
  if (r.code === 'invalid_argument') return { notFound: true };
  return { refused: { code: r.code, message: r.message, ...(r.cap !== undefined ? { cap: r.cap } : {}) } };
}

function replayed(reply: PhoneWorkerResumeReply): PhoneWorkerResumeReply {
  return 'resumed' in reply ? { ...reply, replayed: true } : reply;
}

/** `workspaces.workerResume`; null for any other command. */
export async function handlePhoneWorkerResumeCommand(
  command: string,
  payload: Record<string, unknown>,
  deps: PhoneWorkerResumeDeps = defaultDeps(),
): Promise<PhoneWorkerResumeReply | null> {
  if (command !== PHONE_WORKER_RESUME_COMMAND) return null;
  const taskId = payload.taskId;
  if (!isPhoneWorkerTaskId(taskId)) return { notFound: true };
  const now = deps.now();
  const id = payload.clientRequestId;
  if (checkChatId(id, now, PHONE_WORKER_RESUME_WINDOW_MS) !== 'ok') return { invalid: true };
  // A device id the daemon sent must be one: it keys the receipts, and a
  // malformed one never falls back to the operator's.
  if (payload.deviceId !== undefined && !(typeof payload.deviceId === 'string' && DEVICE_ID_RE.test(payload.deviceId))) return { invalid: true };
  const deviceId = payload.deviceId as string | undefined;
  for (const [k, r] of receipts) if (r.expiresAt <= now && !r.pending) receipts.delete(k);
  const key = `${deviceId ?? 'operator'}\0${id as string}`;
  const seen = receipts.get(key);
  if (seen) {
    if (seen.taskId !== taskId) return { idReused: true };
    if (seen.done) return replayed(seen.done);
    if (seen.pending) return replayed(await seen.pending);
  }
  if (receipts.size >= PHONE_WORKER_RESUME_RECEIPTS_MAX) return { full: true };
  if (!deps.taskKnown(taskId)) return { notFound: true };
  // Kept for as long as the id itself is accepted (an id may be stamped a
  // little ahead of this clock).
  const receipt: Receipt = { taskId, expiresAt: chatIdTime(id as string) + PHONE_WORKER_RESUME_WINDOW_MS };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<PhoneWorkerResumeReply>((resolve) => {
    timer = setTimeout(() => resolve({ refused: { code: 'busy', message: 'the resume is still under way; try again in a moment' } }), deps.waitMs ?? PHONE_WORKER_RESUME_WAIT_MS);
    timer.unref?.();
  });
  receipt.pending = Promise.race([deps.resume(taskId).then(replyOf), late]).finally(() => clearTimeout(timer));
  receipts.set(key, receipt);
  let reply: PhoneWorkerResumeReply | null = null;
  try {
    reply = await receipt.pending;
  } finally {
    receipt.pending = undefined;
    // A refusal is not kept: a repeat runs the checks again (a worker that
    // did start reads as resumed there).
    if (reply && 'resumed' in reply) receipt.done = reply;
    else if (receipts.get(key) === receipt) receipts.delete(key);
  }
  if ('resumed' in reply) deps.log(`[phone] worker of ${taskId} resumed from ${deviceId ? `device ${deviceId}` : 'the operator token'}`);
  return reply;
}
