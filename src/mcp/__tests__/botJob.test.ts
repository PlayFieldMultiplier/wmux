import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import '../botJob';
import { installBotTools, registeredToolModules } from '../toolModules';
import { BOT_JOB_MAX } from '../../shared/bot';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

describe('job_set', () => {
  it('sends only the job (main sets the calling bot\'s own), and bounds it', async () => {
    const tools = new Map<string, { shape: Record<string, z.ZodTypeAny>; handler: Handler }>();
    const raw = (name: string, _d: string, shape: Record<string, z.ZodTypeAny>, handler: Handler) => {
      tools.set(name, { shape, handler });
      return { name };
    };
    const callRpc = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
    const module = registeredToolModules().find((m) => m.name === 'bot-job')!;
    installBotTools({ role: 'lead', rawTool: raw as never, rawRegisterTool: raw as never, deps: { role: 'lead', callRpc }, registered: new Set<string>(), modules: [module] });
    const tool = tools.get('job_set')!;
    await tool.handler({ job: 'Fix issues.' });
    await tool.handler({ job: null });
    expect(callRpc.mock.calls.map((c) => c.slice(0, 2))).toEqual([['bot.setJob', { job: 'Fix issues.' }], ['bot.setJob', { job: null }]]);
    const shape = z.object(tool.shape);
    expect(shape.safeParse({ job: 'x'.repeat(BOT_JOB_MAX + 1) }).success).toBe(false);
    expect(shape.safeParse({ job: '' }).success).toBe(false);
    expect(shape.safeParse({ job: 'ok', botId: 'bot-0a1b2c3d' }).data).toEqual({ job: 'ok' });
  });
});
