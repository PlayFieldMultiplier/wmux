// ─── A bot's saved workflow, as one card in its conversation (pure) ──────
//
// A workflow (shared/botWorkflow.ts) is a bot's plan of up to eight code
// steps, one worker each; a step's verified result (a passing system gate
// on a commit, or a merged pull request) lets the next one start. The owner
// reads it as one card in the conversation it was saved from, at the time
// it was saved: its state, the step it is on, why it stopped in plain
// words, and the last verified result (which step, what was verified, and
// when). Cancel (the owner IPC) stops the steps not yet started; a step
// already running keeps its worker. This module derives the card's view and
// places it; BotsWorkflowCard.tsx draws it.
import { WORKFLOW_BLOCK, workflowTaskBlocked, type WorkflowView } from '../../../shared/botWorkflow';
import type { ThreadId } from '../../../shared/room';
import type { TimelineItem } from './botsTimeline';

export type WorkflowState = 'running' | 'blocked' | 'cancelled' | 'done';

/** Why a workflow stopped. `step` is 1-based. */
export type WorkflowReason =
  /** The owner's Cancel; `started`: the step had already been handed to a
   *  worker, which keeps running. */
  | { kind: 'cancelled'; step: number; started: boolean }
  /** The owner stopped the bot (its workers with it). */
  | { kind: 'stopped' }
  | { kind: 'taskFailed' | 'taskCancelled' | 'taskUnverified' | 'unknownDispatch' | 'multipleTasks' | 'bindingChanged'; step: number }
  /** A reason main words itself (a worker that could not start). */
  | { kind: 'other'; step: number; text: string };

export interface WorkflowLastVerified {
  step: number;
  title: string;
  headSha?: string;
  mergedPr?: number;
  summary: string;
  /** Absent on a result recorded before the time was kept. */
  at?: number;
}

export interface WorkflowCardView {
  state: WorkflowState;
  /** The step it is on (1-based); the last one when done. */
  step: number;
  total: number;
  reason: WorkflowReason | null;
  /** Cancelled by the owner while already blocked: `reason` is that block. */
  cancelledWhileBlocked: boolean;
  last: WorkflowLastVerified | null;
  /** Running or blocked, and not stopped by the owner. */
  canCancel: boolean;
}

const TASK_BLOCKS = [['failed', 'taskFailed'], ['cancelled', 'taskCancelled'], ['completed', 'taskUnverified']] as const;

function reasonOf(w: WorkflowView): WorkflowReason | null {
  const index = w.steps.findIndex((s) => s.state === 'blocked');
  if (index < 0) return null;
  const s = w.steps[index];
  const step = index + 1;
  const text = s.error ?? w.blockedReason ?? '';
  if (text === WORKFLOW_BLOCK.cancelled) return { kind: 'cancelled', step, started: s.dispatchKey !== undefined };
  if (text === WORKFLOW_BLOCK.stopped) return { kind: 'stopped' };
  if (text === WORKFLOW_BLOCK.unknownDispatch) return { kind: 'unknownDispatch', step };
  if (text === WORKFLOW_BLOCK.multipleTasks) return { kind: 'multipleTasks', step };
  if (text === WORKFLOW_BLOCK.bindingChanged) return { kind: 'bindingChanged', step };
  if (s.taskId) {
    for (const [status, kind] of TASK_BLOCKS) if (text === workflowTaskBlocked(s.taskId, status)) return { kind, step };
  }
  return { kind: 'other', step, text };
}

function lastVerifiedOf(w: WorkflowView): WorkflowLastVerified | null {
  for (let i = w.steps.length - 1; i >= 0; i--) {
    const r = w.steps[i].result;
    if (!r) continue;
    return {
      step: i + 1, title: w.steps[i].title, summary: r.summary,
      ...(r.headSha ? { headSha: r.headSha } : {}),
      ...(r.mergedPr !== undefined ? { mergedPr: r.mergedPr } : {}),
      ...(r.at !== undefined ? { at: r.at } : {}),
    };
  }
  return null;
}

export function workflowCardView(w: WorkflowView): WorkflowCardView {
  const state: WorkflowState = w.state === 'completed' ? 'done' : w.stoppedByOwner ? 'cancelled' : w.state === 'blocked' ? 'blocked' : 'running';
  const open = w.steps.findIndex((s) => s.state !== 'completed');
  const reason = reasonOf(w);
  return {
    state,
    step: open < 0 ? w.steps.length : open + 1,
    total: w.steps.length,
    reason,
    cancelledWhileBlocked: state === 'cancelled' && reason !== null && reason.kind !== 'cancelled' && reason.kind !== 'stopped',
    last: lastVerifiedOf(w),
    canCancel: state === 'running' || state === 'blocked',
  };
}

/** The workflows saved from these threads of one workspace, oldest first. */
export function conversationWorkflows(workflows: readonly WorkflowView[], workspaceId: string, threads: readonly ThreadId[]): WorkflowView[] {
  return workflows
    .filter((w) => w.workspaceId === workspaceId && threads.includes(w.threadId))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export type WorkflowTimelineItem = TimelineItem | { kind: 'workflow'; key: string; workflow: WorkflowView; at: number };

function itemAt(item: TimelineItem): number | null {
  switch (item.kind) {
    case 'day': return item.at;
    case 'new': return null;
    case 'system': return item.cards[0]?.at ?? null;
    case 'message': return item.card.at;
    case 'work': return item.at;
  }
}

/** The timeline with each workflow's card at the time it was saved: after
 *  the last item at or before then, and never inside a run of bubbles. */
export function withWorkflows(items: readonly TimelineItem[], workflows: readonly WorkflowView[]): WorkflowTimelineItem[] {
  const out: WorkflowTimelineItem[] = [...items];
  for (const workflow of [...workflows].sort((a, b) => a.createdAt - b.createdAt)) {
    let at = 0;
    for (let i = 0; i < out.length; i++) {
      const item = out[i];
      const time = item.kind === 'workflow' ? item.at : itemAt(item);
      if (time !== null && time <= workflow.createdAt) at = i + 1;
    }
    while (at < out.length) {
      const next = out[at];
      if ((next.kind === 'message' || next.kind === 'work') && next.continuation) at++;
      else break;
    }
    out.splice(at, 0, { kind: 'workflow', key: `workflow:${workflow.id}`, workflow, at: workflow.createdAt });
  }
  return out;
}
