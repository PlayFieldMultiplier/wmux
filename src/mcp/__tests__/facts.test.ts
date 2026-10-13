// fact_poll: forwards a bounded, cursor-based fact.poll and never sends a
// workspace (main scopes on the bot token).
import { describe, expect, it, vi } from 'vitest';
import { registeredToolModules, type ToolModuleDeps, type ToolModuleHost } from '../toolModules';
import { FACT_LIMITS, FACT_RPC } from '../../shared/facts';
import '../facts';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function install() {
  const module = registeredToolModules().find((m) => m.name === 'facts');
  if (!module) throw new Error('facts module not registered');
  let handler: Handler | null = null;
  const host = { tool: (_name: string, _d: string, _s: unknown, cb: Handler) => { handler = cb; } } as unknown as ToolModuleHost;
  const callRpc = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
  module.register(host, { role: 'lead', callRpc } as ToolModuleDeps);
  return { module, call: (args: Record<string, unknown>) => (handler as unknown as Handler)(args), callRpc };
}

describe('fact_poll', () => {
  it('owns fact_poll only', () => {
    expect(install().module.tools).toEqual(['fact_poll']);
  });

  it('defaults to one page from now, without a workspace', async () => {
    const { call, callRpc } = install();
    await call({});
    expect(callRpc).toHaveBeenCalledWith(FACT_RPC.poll, { limit: FACT_LIMITS.POLL_PAGE }, undefined);
  });

  it('passes the cursor, kinds and a block with a matching RPC timeout', async () => {
    const { call, callRpc } = install();
    await call({ since_seq: 7, kinds: ['task.done'], limit: 5, block_ms: 20_000 });
    expect(callRpc).toHaveBeenCalledWith(FACT_RPC.poll, { sinceSeq: 7, kinds: ['task.done'], limit: 5, blockMs: 20_000 }, 30_000);
  });
});
