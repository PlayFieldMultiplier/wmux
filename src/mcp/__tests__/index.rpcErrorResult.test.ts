import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// The SDK's subpath exports resolve under vitest but not under the import plugin.
// eslint-disable-next-line import/no-unresolved
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// eslint-disable-next-line import/no-unresolved
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Main answers many refusals as a RESULT (`{ error }`, `{ ok: false, ... }`)
 * rather than a throw, so the pipe envelope stays ok. callRpc must still mark
 * those `isError`: an agent that checks only `isError` read a refused
 * send_message (an image outside the allowed folders) as a success.
 *
 * Same harness as index.resultCap.test.ts: a real McpServer over an in-memory
 * transport pair; the only mock is wmux-client's sendRpc.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { createWmuxServer, withNote } from '../index';
import { isErrorShapedResult } from '../../shared/rpc';

async function connectClient(bot?: { botRole: string; token: string }) {
  const server = createWmuxServer({
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderToken: bot?.token,
    commanderMode: false,
    coreMode: false,
    ...(bot && { botRole: bot.botRole }),
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => client.close() };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string; blocks: number }> {
  const result = await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  };
  return { isError: result.isError, text: result.content[0]?.text ?? '', blocks: result.content.length };
}

/** Answer the identity walk with a verified hit and `method` with `reply`. */
function answer(method: string, reply: unknown): void {
  mockSendRpc.mockImplementation(async (m: string) => {
    if (m === 'a2a.resolve.identity') return { resolved: { workspaceId: 'ws-test', ptyId: 'pty-1' } };
    if (m === method) return reply;
    throw new Error(`rpc-down: ${m}`);
  });
}

describe('isErrorShapedResult', () => {
  it('flags a top-level error string with no ok, and any ok:false', () => {
    expect(isErrorShapedResult({ error: 'refused' })).toBe(true);
    expect(isErrorShapedResult({ ok: false, error: 'refused' })).toBe(true);
    expect(isErrorShapedResult({ ok: false, code: 'not_started', message: 'later' })).toBe(true);
    expect(isErrorShapedResult({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'bad' } })).toBe(true);
  });

  it('leaves data alone: ok:true beside an error, an empty error, per-item errors, non-objects', () => {
    expect(isErrorShapedResult({ ok: true, error: 'kept as data' })).toBe(false);
    expect(isErrorShapedResult({ error: '' })).toBe(false);
    expect(isErrorShapedResult({ error: null })).toBe(false);
    expect(isErrorShapedResult({ items: [{ error: 'one item failed' }] })).toBe(false);
    expect(isErrorShapedResult([{ error: 'x' }])).toBe(false);
    expect(isErrorShapedResult('error: plain text')).toBe(false);
    expect(isErrorShapedResult(null)).toBe(false);
  });
});

describe('callRpc marks a refusal answered as a result', () => {
  beforeEach(() => {
    mockSendRpc.mockReset();
  });

  it('sets isError for { error } and { ok: false, error }, with the text unchanged', async () => {
    const { client, close } = await connectClient();
    try {
      for (const reply of [{ error: 'workspace.list: refused' }, { ok: false, error: 'workspace.list: refused' }]) {
        answer('workspace.list', reply);
        const res = await callTool(client, 'workspace_list', {});
        expect(res.isError).toBe(true);
        expect(res.text).toBe(JSON.stringify(reply, null, 2));
      }
    } finally {
      await close();
    }
  });

  it('leaves a success without isError, including one with ok:true beside an error field', async () => {
    const { client, close } = await connectClient();
    try {
      for (const reply of [{ workspaces: [] }, { ok: true, error: 'informational' }]) {
        answer('workspace.list', reply);
        const res = await callTool(client, 'workspace_list', {});
        expect(res.isError).toBeFalsy();
        expect(res.text).toBe(JSON.stringify(reply, null, 2));
      }
    } finally {
      await close();
    }
  });

  it('send_message with a refused image returns isError', async () => {
    const refusal = {
      error: 'a2a.task.send: bad-request: images[0] "/elsewhere/shot.png": only files in your pane\'s project folder or in ~/.wmux/uploads/ can be attached; copy it there first',
    };
    answer('a2a.task.send', refusal);
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'send_message', { to: 'ws-other', message: 'look', images: ['/elsewhere/shot.png'] });
      expect(res.isError).toBe(true);
      expect(res.text).toBe(JSON.stringify(refusal, null, 2));
    } finally {
      await close();
    }
  });
});

describe('send_message WSL image hint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names this instance\'s uploads folder', async () => {
    vi.stubEnv('WMUX_WSL_DISTRO', 'Ubuntu');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-dogm');
    answer('a2a.task.send', { ok: true });
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'send_message', { to: 'ws-other', message: 'look', images: ['/home/me/shot.png'] });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('/mnt/c/Users/<you>/.wmux-dogm/uploads/');
    } finally {
      await close();
    }
  });
});

describe('results callRpc hands on keep the flag', () => {
  beforeEach(() => {
    mockSendRpc.mockReset();
  });

  it('withNote keeps isError and appends its note', () => {
    const noted = withNote({ content: [{ type: 'text', text: '{"error":"x"}' }], isError: true }, 'careful');
    expect(noted.isError).toBe(true);
    expect(noted.content.map((c) => c.text)).toEqual(['{"error":"x"}', 'NOTE: careful']);
    expect(withNote({ content: [{ type: 'text', text: '{}' }] }, 'n').isError).toBeUndefined();
  });

  it('a refused terminal_send_key Enter is isError with no delivery note; a delivered one gets the note', async () => {
    const { client, close } = await connectClient();
    try {
      answer('input.sendKey', { error: 'input.sendKey: refused' });
      const refused = await callTool(client, 'terminal_send_key', { key: 'Enter' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(JSON.stringify({ error: 'input.sendKey: refused' }, null, 2));
      expect(refused.blocks).toBe(1);

      answer('input.sendKey', { ok: true });
      const delivered = await callTool(client, 'terminal_send_key', { key: 'Enter' });
      expect(delivered.isError).toBeFalsy();
      expect(delivered.blocks).toBe(2);
    } finally {
      await close();
    }
  });

  it('a bot-lane tool (the deps.callRpc spread) carries isError', async () => {
    const refusal = { ok: false, code: 'not_authorized', message: 'only a bot sets its job' };
    answer('bot.setJob', refusal);
    const { client, close } = await connectClient({ botRole: 'lead', token: 'tok' });
    try {
      const res = await callTool(client, 'job_set', { job: 'Fix issues.' });
      expect(res.isError).toBe(true);
      expect(res.text).toBe(JSON.stringify(refusal, null, 2));
    } finally {
      await close();
    }
  });

  it('a2a_discover keeps a refusal untouched and flagged, and stamps elapsedMs only on a success', async () => {
    const { client, close } = await connectClient();
    try {
      answer('a2a.discover', { error: 'a2a.discover: refused' });
      const refused = await callTool(client, 'a2a_discover', {});
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(JSON.stringify({ error: 'a2a.discover: refused' }, null, 2));

      answer('a2a.discover', { ok: false, code: 'not_started' });
      const noErrorKey = await callTool(client, 'a2a_discover', {});
      expect(noErrorKey.isError).toBe(true);
      expect(noErrorKey.text).toBe(JSON.stringify({ ok: false, code: 'not_started' }, null, 2));

      answer('a2a.discover', { agents: [] });
      const found = await callTool(client, 'a2a_discover', {});
      expect(found.isError).toBeFalsy();
      expect(JSON.parse(found.text)).toMatchObject({ agents: [], elapsedMs: expect.any(Number) });
    } finally {
      await close();
    }
  });
});
