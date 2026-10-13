import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The SDK's subpath exports resolve under vitest but not under the import plugin.
// eslint-disable-next-line import/no-unresolved
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import/no-unresolved
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BOT_ROLES } from '../../shared/bot';
import { BOT_TOOL_RPC, ROLE_SURFACES } from '../../shared/botSurface';
import baseline from '../../../scripts/mcp-protocol-baseline.json';

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
  it.each(BOT_ROLES)('%s lists exactly the shared bot surface', async (role) => {
    const names = await listNames({ botRole: role, token: 'tok' });
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...ROLE_SURFACES[role].tools].sort());
  });

  it.each(BOT_ROLES)('%s stays inside its tools/list budget (scripts/mcp-protocol-baseline.json botProfiles)', async (role) => {
    const budget = (baseline as { botProfiles: Record<string, { maxListBytes: number }> }).botProfiles[role]?.maxListBytes;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(baseline.profiles.commander.maxListBytes);
    const client = await connect({ botRole: role, token: 'tok' });
    try {
      const bytes = Buffer.byteLength(JSON.stringify(await client.listTools()), 'utf8');
      expect(bytes).toBeLessThanOrEqual(budget);
    } finally {
      await client.close();
    }
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

  it('a role tool calls its RPC with the mapped arguments and no identity', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, code: 'not_started' });
    const client = await connect({ botRole: 'verifier', token: 'tok' });
    try {
      const result = await client.callTool({ name: 'pr_read', arguments: { pr_number: 1 } });
      expect(mockSendRpc).toHaveBeenCalledWith(BOT_TOOL_RPC.pr_read[0], { prNumber: 1 });
      expect(JSON.stringify(result.content)).toContain('not_started');
    } finally {
      await client.close();
    }
  });

  it.each(BOT_ROLES)('%s gets the bot instructions, not the commander\'s', async (role) => {
    const client = await connect({ botRole: role, token: 'tok' });
    try {
      const text = client.getInstructions() ?? '';
      expect(text).toMatch(/^wmux factory bot tools/);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2 * 1024);
      const allTools = Object.keys(BOT_TOOL_RPC);
      const named = allTools.filter((t) => new RegExp(`(?<![a-z_])${t}(?![a-z_])`).test(text));
      expect(named.filter((t) => !ROLE_SURFACES[role].tools.has(t))).toEqual([]);
    } finally {
      await client.close();
    }
    const commander = await connect({ commanderMode: true, token: 'tok' });
    try {
      expect(commander.getInstructions()).not.toMatch(/factory/);
    } finally {
      await commander.close();
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
