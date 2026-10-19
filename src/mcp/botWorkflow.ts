import { z } from 'zod';
import { WORKFLOW_LIMITS, WORKFLOW_RPC } from '../shared/botWorkflow';
import { registerToolModule } from './toolModules';

registerToolModule({
  name: 'bot-workflow',
  tools: ['workflow_create', 'workflow_read', 'workflow_advance'],
  register(host, deps) {
    host.tool('workflow_create',
      'Save an ordered code workflow for your own workspace. Reuse client_workflow_id when retrying the same definition, including after restart. '
        + 'This saves the steps; workflow_advance starts the next eligible worker through your normal fan-out budget and permissions. '
        + 'A step unlocks its successor only after system-verified completion. Research steps are not supported.', {
        client_workflow_id: z.string().min(1).max(WORKFLOW_LIMITS.clientIdChars),
        title: z.string().min(1).max(WORKFLOW_LIMITS.titleChars),
        steps: z.array(z.object({
          title: z.string().min(1).max(WORKFLOW_LIMITS.titleChars),
          prompt: z.string().min(1).max(WORKFLOW_LIMITS.promptChars).describe(`At most ${WORKFLOW_LIMITS.promptBytes} UTF-8 bytes; main also reserves room for worker instructions and the predecessor result.`),
        })).min(1).max(WORKFLOW_LIMITS.steps),
      }, async ({ client_workflow_id, title, steps }) => ({
        ...(await deps.callRpc(WORKFLOW_RPC.create, { clientWorkflowId: client_workflow_id, title, steps })),
      }));
    host.tool('workflow_read',
      'Read your saved workflow and task/result bindings, or list your workflows when workflow_id is omitted. '
        + 'Review a blocked step before deciding how to recover; never recreate an ambiguous dispatch.', {
        workflow_id: z.string().min(1).max(128).optional(),
      }, async ({ workflow_id }) => ({
        ...(await deps.callRpc(WORKFLOW_RPC.read, workflow_id ? { workflowId: workflow_id } : {})),
      }));
    host.tool('workflow_advance',
      'Reconcile recorded results and start at most one pending code step. Completed or already dispatched steps are never sent again. '
        + 'Use the current wake idempotency key (wake:<wakeId>:<n>), sharing the same ordinal sequence as fanout_start. '
        + 'A failed gate, uncertain dispatch, or unverified completion blocks dependent steps.', {
        workflow_id: z.string().min(1).max(128),
        idempotency_key: z.string().min(1).max(200),
      }, async ({ workflow_id, idempotency_key }) => ({
        ...(await deps.callRpc(WORKFLOW_RPC.advance, { workflowId: workflow_id, idempotencyKey: idempotency_key })),
      }));
  },
});
