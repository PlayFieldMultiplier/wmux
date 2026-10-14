import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import '../factoryTools';
import { installBotTools, registeredToolModules } from '../toolModules';
import { BOT_ROLES } from '../../shared/bot';
import { ROLE_SURFACES } from '../../shared/botSurface';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
const ROLE_TOOLS = ['pr_read', 'issue_read', 'ci_read', 'verdict_read', 'pr_verdict', 'trust_metrics_read', 'plan_propose', 'bot_list', 'bot_park'];

function install(role: (typeof BOT_ROLES)[number]) {
  const tools = new Map<string, { description: string; shape: Record<string, z.ZodTypeAny>; handler: Handler }>();
  const raw = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: Handler) => {
    tools.set(name, { description, shape, handler });
    return { name };
  };
  const callRpc = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
  const module = registeredToolModules().find((m) => m.name === 'factory-role-tools')!;
  installBotTools({ role, rawTool: raw as never, rawRegisterTool: raw as never, deps: { role, callRpc }, registered: new Set<string>(), modules: [module] });
  return { tools, callRpc };
}

describe('factory role tools', () => {
  it('each role gets exactly the role tools on its surface, from this module', () => {
    for (const role of BOT_ROLES) {
      const { tools } = install(role);
      for (const name of ROLE_TOOLS) {
        const onSurface = ROLE_SURFACES[role].tools.has(name);
        if (onSurface) expect(tools.get(name)?.description, `${role} ${name}`).not.toMatch(/Not available in this build/);
        else expect(tools.has(name), `${role} ${name}`).toBe(false);
      }
    }
  });

  it('maps args onto the RPC params and sends no identity or repository', async () => {
    const { tools, callRpc } = install('moa');
    await tools.get('pr_read')!.handler({ pr_number: 3, workspace_id: 'ws-a' });
    await tools.get('issue_read')!.handler({ label: 'bug' });
    await tools.get('ci_read')!.handler({});
    await tools.get('trust_metrics_read')!.handler({ since_days: 14 });
    await tools.get('plan_propose')!.handler({ title: 'Plan', items: [{ workspace_id: 'ws-a', title: 'Fix', size: 'S', why: 'flaky' }] });
    await tools.get('bot_list')!.handler({});
    expect(tools.has('bot_park')).toBe(false);
    expect(callRpc.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['pr.read', { prNumber: 3, workspaceId: 'ws-a' }],
      ['issue.read', { label: 'bug' }],
      ['ci.read', {}],
      ['trustMetrics.read', { sinceDays: 14 }],
      ['plan.propose', { title: 'Plan', items: [{ workspaceId: 'ws-a', title: 'Fix', size: 'S', why: 'flaky' }] }],
      ['bot.list', {}],
    ]);
  });

  it('pr_verdict sends the evidence task and allows the verdict store\'s time', async () => {
    const { tools, callRpc } = install('verifier');
    const sha = 'c'.repeat(40);
    await tools.get('pr_verdict')!.handler({ pr_number: 7, head_sha: sha, verdict: 'pass', summary: 'green', evidence: { task_id: 't-1' } });
    expect(callRpc).toHaveBeenCalledWith('verify.recordVerdict', { prNumber: 7, headSha: sha, verdict: 'pass', summary: 'green', evidence: { taskId: 't-1' } }, 30_000);
    const shape = z.object(tools.get('pr_verdict')!.shape);
    expect(shape.safeParse({ pr_number: 7, head_sha: sha, verdict: 'pass', summary: 's' }).success).toBe(false);
    expect(shape.safeParse({ pr_number: 7, head_sha: 'HEAD', verdict: 'pass', summary: 's', evidence: { task_id: 't' } }).success).toBe(false);
    expect(shape.safeParse({ pr_number: 7, head_sha: sha, verdict: 'pass', summary: 's', evidence: { task_id: 't', gate_head_sha: sha } }).success).toBe(false);
  });

  it('bounds plan items', () => {
    const { tools } = install('moa');
    const plan = z.object(tools.get('plan_propose')!.shape);
    const item = { workspace_id: 'ws', title: 't', size: 'S', why: 'w' };
    expect(plan.safeParse({ title: 't', items: [] }).success).toBe(false);
    expect(plan.safeParse({ title: 't', items: Array.from({ length: 11 }, () => item) }).success).toBe(false);
    expect(plan.safeParse({ title: 't', items: [{ ...item, size: 'XL' }] }).success).toBe(false);
    expect(plan.safeParse({ title: 't', items: [item] }).success).toBe(true);
  });
});
