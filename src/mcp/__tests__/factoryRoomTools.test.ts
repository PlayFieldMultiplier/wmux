import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import '../factory';
import { installBotTools, registeredToolModules } from '../toolModules';
import { BOT_ROLES } from '../../shared/bot';
import { ROOM_LIMITS } from '../../shared/room';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function install(role: (typeof BOT_ROLES)[number]) {
  const tools = new Map<string, { description: string; shape: Record<string, z.ZodTypeAny>; handler: Handler }>();
  const raw = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: Handler) => {
    tools.set(name, { description, shape, handler });
    return { name };
  };
  const callRpc = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
  const module = registeredToolModules().find((m) => m.name === 'factory-rooms')!;
  installBotTools({
    role,
    rawTool: raw as never,
    rawRegisterTool: raw as never,
    deps: { role, callRpc },
    registered: new Set<string>(),
    modules: [module],
  });
  return { tools, callRpc };
}

describe('factory room tools', () => {
  it('every role holds room_post, room_read, handoff_send and ask_person from this module', () => {
    for (const role of BOT_ROLES) {
      const { tools } = install(role);
      for (const name of ['room_post', 'room_read', 'handoff_send', 'ask_person']) {
        expect(tools.get(name)?.description, `${role} ${name}`).not.toMatch(/Not available in this build/);
      }
    }
  });

  it('maps tool args onto the RPC params and sends no identity', async () => {
    const { tools, callRpc } = install('lead');
    await tools.get('room_post')!.handler({ kind: 'status', title: 'T', thread_id: 'task:t1', reply_to: 'c-1' });
    await tools.get('room_read')!.handler({ since_seq: 4, limit: 10 });
    await tools.get('handoff_send')!.handler({ kind: 'result', title: 'done', body: 'b', reply_to: 'h-1' });
    await tools.get('ask_person')!.handler({ title: 'Q?', options: ['a', 'b'] });
    expect(callRpc.mock.calls).toEqual([
      ['room.post', { kind: 'status', title: 'T', threadId: 'task:t1', replyTo: 'c-1' }],
      ['room.read', { sinceSeq: 4, limit: 10 }],
      ['handoff.send', { kind: 'result', title: 'done', body: 'b', replyTo: 'h-1' }],
      ['ask.person', { title: 'Q?', options: ['a', 'b'] }],
    ]);
  });

  it('bounds the inputs', () => {
    const { tools } = install('lead');
    const post = z.object(tools.get('room_post')!.shape);
    expect(post.safeParse({ kind: 'human', title: 't' }).success).toBe(false);
    expect(post.safeParse({ kind: 'status', title: 'x'.repeat(ROOM_LIMITS.TITLE_MAX + 1) }).success).toBe(false);
    expect(post.safeParse({ kind: 'status', title: 't', body: 'x'.repeat(ROOM_LIMITS.CARD_BODY_MAX + 1) }).success).toBe(false);
    const ask = z.object(tools.get('ask_person')!.shape);
    expect(ask.safeParse({ title: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }).success).toBe(false);
    const read = z.object(tools.get('room_read')!.shape);
    expect(read.safeParse({ limit: ROOM_LIMITS.PAGE + 1 }).success).toBe(false);
  });
});
