import type { RpcContext } from '../../shared/rpc';
import type { WorkflowTaskBinding } from '../../shared/botWorkflow';

/** In-process only: wire fan-out parameters can never supply this stamp. */
export interface WorkflowDispatchBinding extends WorkflowTaskBinding {
  tainted: boolean;
  repoKey: string;
  baseSha?: string;
  onStartFailed(reason: string): void;
}
export type WorkflowFanout = (params: Record<string, unknown>, ctx: RpcContext, binding: WorkflowDispatchBinding) => Promise<unknown>;
let current: WorkflowFanout | null = null;
export function setWorkflowFanout(port: WorkflowFanout): void { current = port; }
export function getWorkflowFanout(): WorkflowFanout | null { return current; }
