import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import '../botWorkflow';
import { installBotTools, registeredToolModules } from '../toolModules';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

describe('workflow tools', () => {
  it('exposes bounded own-workflow tools and translates parameters without caller identity', async () => {
    const tools = new Map<string, { shape: Record<string, z.ZodTypeAny>; handler: Handler }>();
    const raw = (name: string, _description: string, shape: Record<string, z.ZodTypeAny>, handler: Handler) => {
      tools.set(name, { shape, handler });
      return { name };
    };
    const callRpc = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
    const module = registeredToolModules().find((m) => m.name === 'bot-workflow')!;
    installBotTools({ role: 'lead', rawTool: raw as never, rawRegisterTool: raw as never, deps: { role: 'lead', callRpc }, registered: new Set<string>(), modules: [module] });
    const steps = [{ title: 'Fix', prompt: 'Fix the reported bug.' }];
    await tools.get('workflow_create')!.handler({ client_workflow_id: 'bug-42', title: 'Fix bug', steps });
    await tools.get('workflow_read')!.handler({});
    await tools.get('workflow_advance')!.handler({ workflow_id: 'wf-1', idempotency_key: 'wake:w:1' });
    expect(callRpc.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['workflow.create', { clientWorkflowId: 'bug-42', title: 'Fix bug', steps }],
      ['workflow.read', {}],
      ['workflow.advance', { workflowId: 'wf-1', idempotencyKey: 'wake:w:1' }],
    ]);
    const schema = z.object(tools.get('workflow_create')!.shape);
    expect(schema.safeParse({ client_workflow_id: 'a', title: 'a', steps: [] }).success).toBe(false);
    expect(schema.safeParse({ client_workflow_id: 'a', title: 'a', steps: Array(9).fill(steps[0]) }).success).toBe(false);
    expect(schema.parse({ client_workflow_id: 'a', title: 'a', steps, botId: 'other' })).not.toHaveProperty('botId');
  });
});
