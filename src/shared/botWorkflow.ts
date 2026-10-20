import type { ThreadId } from './room';

/** Owner IPC channels are separate from the bot's RPC surface. */
export const WORKFLOW_OWNER_IPC = { read: 'factory:workflow:read', cancel: 'factory:workflow:cancel' } as const;
export const WORKFLOW_RPC = { create: 'workflow.create', read: 'workflow.read', advance: 'workflow.advance' } as const;
// History is retained to prevent replay: each owner has its own quota, with
// a separate aggregate storage ceiling that fails closed without deletion.
export const WORKFLOW_LIMITS = { steps: 8, records: 500, totalRecords: 5_000, promptChars: 6_000, promptBytes: 6_000, titleChars: 200, clientIdChars: 128 } as const;

export interface WorkflowStepInput { title: string; prompt: string; }
export interface WorkflowCreateParams { clientWorkflowId: string; title: string; steps: WorkflowStepInput[]; }
export interface WorkflowTaskBinding { id: string; step: number; }
export interface WorkflowResultBinding {
  taskId: string;
  rev: number;
  headSha?: string;
  mergedPr?: number;
  summary: string;
  /** When the task's verified completion was recorded (its ledger row's
   *  last transition). Absent on results recorded before it existed. */
  at?: number;
}
export interface WorkflowStep extends WorkflowStepInput {
  state: 'pending' | 'dispatching' | 'waiting' | 'completed' | 'blocked';
  dispatchKey?: string;
  taskId?: string;
  result?: WorkflowResultBinding;
  error?: string;
}
export interface BotWorkflow {
  id: string;
  clientWorkflowId: string;
  botId: string;
  workspaceId: string;
  repoKey: string;
  threadId: ThreadId;
  tainted: boolean;
  title: string;
  steps: WorkflowStep[];
  state: 'active' | 'completed' | 'blocked';
  /** An explicit stop never resumes or emits another ready wake. */
  stoppedByOwner?: true;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
/** Main's fixed blocking reasons, which the owner's view words in their own
 *  language. Any other reason is shown as written. */
export const WORKFLOW_BLOCK = {
  cancelled: 'Cancelled by owner; remaining steps will not run. Any dispatched worker is left running.',
  stopped: 'Stopped by owner; this workflow will not resume automatically.',
  multipleTasks: 'More than one task claims this step; inspect tasks before continuing.',
  unknownDispatch: 'Dispatch outcome is unknown after restart. Inspect tasks; this step will not be resent automatically.',
  bindingChanged: 'The step task binding changed.',
} as const;
export function workflowTaskBlocked(taskId: string, status: string): string {
  return `Task ${taskId} is ${status}; no verified result permits the next step.`;
}
export function workflowReadyFactId(workflow: Pick<BotWorkflow, 'id' | 'revision'>): string {
  return `workflow.ready:${workflow.id}@${workflow.revision}`;
}

/** Readback fields are derived; cancellation never deletes dispatch evidence. */
export interface WorkflowView extends BotWorkflow {
  blockedReason: string | null;
  lastVerifiedResult: WorkflowResultBinding | null;
}
export function workflowView(workflow: BotWorkflow): WorkflowView {
  return { ...workflow,
    blockedReason: workflow.steps.find((s) => s.state === 'blocked')?.error ?? null,
    lastVerifiedResult: [...workflow.steps].reverse().find((s) => s.result)?.result ?? null,
  };
}
export interface OwnerWorkflowRequest { botId: string; workspaceId: string; workflowId?: string; }
export interface OwnerWorkflowCancelRequest extends OwnerWorkflowRequest { workflowId: string; expectedRevision: number; }
export type OwnerWorkflowFailure = { ok: false; code: 'operator_only' | 'invalid_request' | 'unavailable' | 'not_found' | 'revision_conflict' };
export type OwnerWorkflowReadResult = { ok: true; workflows: WorkflowView[] } | OwnerWorkflowFailure;
export type OwnerWorkflowCancelResult = { ok: true; workflow: WorkflowView } | OwnerWorkflowFailure;
