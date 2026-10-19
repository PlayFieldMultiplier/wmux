import type { ThreadId } from './room';

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
export function workflowReadyFactId(workflow: Pick<BotWorkflow, 'id' | 'revision'>): string {
  return `workflow.ready:${workflow.id}@${workflow.revision}`;
}
