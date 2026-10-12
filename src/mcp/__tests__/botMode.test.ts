import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The SDK's subpath exports resolve under vitest but not under the import plugin.
// eslint-disable-next-line import/no-unresolved
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import/no-unresolved
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BOT_ROLES } from '../../shared/bot';
import { BOT_TOOL_RPC, ROLE_SURFACES } from '../../shared/botSurface';

/**
 * `--bot=<role>` end to end: a real McpServer from createWmuxServer() over an
 * in-memory transport, so the assertion is on the tools/list a host would see.
 */
const { mockSendRpc, mockSetCommanderRole } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  mockSetCommanderRole: vi.fn(),
}));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc, setCommanderRole: mockSetCommanderRole };
});

import { createWmuxServer } from '../index';

async function connect(opts: { botRole?: string; coreMode?: boolean; commanderMode?: boolean; token?: string }) {
  const server = createWmuxServer({
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderToken: opts.token,
    commanderMode: opts.commanderMode ?? false,
    coreMode: opts.coreMode ?? false,
    botRole: opts.botRole,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listNames(opts: Parameters<typeof connect>[0]): Promise<string[]> {
  const client = await connect(opts);
  try {
    if (!client.getServerCapabilities()?.tools) return [];
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockRejectedValue(new Error('rpc-down'));
  mockSetCommanderRole.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errSpy.mockRestore());

describe('--bot surface', () => {
  it.each(BOT_ROLES)('%s lists exactly its role surface', async (role) => {
    const names = await listNames({ botRole: role, token: 'tok' });
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...ROLE_SURFACES[role].tools].sort());
  });

  it('claims the role with the bot token on every RPC, like a commander', async () => {
    await listNames({ botRole: 'lead', token: 'bot-token' });
    expect(mockSetCommanderRole).toHaveBeenCalledWith('bot-token');
  });

  it('claims the role with an empty token when none was handed over (main refuses it)', async () => {
    await listNames({ botRole: 'lead' });
    expect(mockSetCommanderRole).toHaveBeenCalledWith('');
  });

  it('an unknown role lists no tools and says so', async () => {
    expect(await listNames({ botRole: 'wizard', token: 'tok' })).toEqual([]);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('unknown --bot=wizard');
    expect(mockSetCommanderRole).toHaveBeenCalledWith('tok');
  });

  it('wins over --core', async () => {
    const names = await listNames({ botRole: 'moa', token: 'tok', coreMode: true });
    expect([...names].sort()).toEqual([...ROLE_SURFACES.moa.tools].sort());
  });

  it('a placeholder forwards its arguments to the tool\'s RPC', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, code: 'not_implemented' });
    const client = await connect({ botRole: 'verifier', token: 'tok' });
    try {
      const result = await client.callTool({ name: 'room_post', arguments: { args: { kind: 'status', title: 'hi' } } });
      expect(mockSendRpc).toHaveBeenCalledWith(BOT_TOOL_RPC.room_post[0], { kind: 'status', title: 'hi' });
      expect(JSON.stringify(result.content)).toContain('not_implemented');
    } finally {
      await client.close();
    }
  });

  it('leaves the full, core and commander profiles without any bot-only tool', async () => {
    const botOnly = ['fact_poll', 'room_post', 'room_read', 'handoff_send', 'ask_person', 'pr_read', 'issue_read', 'ci_read',
      'verdict_read', 'trust_metrics_read', 'plan_propose', 'bot_list', 'bot_park'];
    for (const opts of [{}, { coreMode: true }, { commanderMode: true, token: 'tok' }]) {
      const names = await listNames(opts);
      for (const tool of botOnly) expect(names, JSON.stringify(opts)).not.toContain(tool);
    }
  });
});
