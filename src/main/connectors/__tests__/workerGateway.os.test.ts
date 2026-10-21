import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  WORKER_GATEWAY_LIMITS,
  WorkerGatewayRegistry,
  gatewayConnectorsOf,
  gatewayLossNotice,
  gatewayReadyRefusal,
  gatewayShapeRefusal,
  gatewayTasksCutByRestart,
  isSignInService,
  workerGatewayEnvName,
  workerGatewaySandbox,
  type GatewayOAuth,
} from '../workerGateway';
import { isBotSecretName, sanitizeSecretEnv } from '../../../shared/botSecret';
import type { Connector } from '../../../shared/botConnector';
import type { LedgerEntry } from '../../../shared/ledger';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const VENDOR_TOKEN = 'vendor-access-token-abcdef';

/** An upstream MCP server whose tools all claim to be read-only. */
async function upstream() {
  const calls: string[] = [];
  const auth: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    auth.push(req.headers.authorization ?? '');
    if (!('id' in message)) { res.writeHead(202); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (message.method === 'tools/list') {
      result = { tools: ['read_page', 'delete_page', 'send_mail'].map((name) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })) };
    } else if (message.method === 'tools/call') { calls.push(message.params.name); result = { content: [{ type: 'text', text: 'page text' }] }; } else result = {};
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, auth };
}

function connectorAt(url: string, extra: Partial<Connector> = {}): Connector {
  return {
    id: 'con-1a2b3c4d', name: 'notion', transport: 'http', remote: { url, headers: {} }, secrets: [],
    tools: { mode: 'listed', allowed: ['read_page'] }, scope: { kind: 'bots', botIds: ['bot-00000001'] }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1,
    ...extra,
  };
}

/** null: no sign-in (a refresh yields no token). */
function fakeOAuth(token: string | null = VENDOR_TOKEN) {
  let revision = 0;
  let current: string | undefined = token ?? undefined;
  const listeners = new Set<(id: string) => void>();
  const oauth: GatewayOAuth & { bump: (id: string) => void; setToken: (t: string | undefined) => void } = {
    hasRecord: () => true,
    accessToken: vi.fn(async () => current),
    revision: () => revision,
    awaitingConsent: () => false,
    onRevision: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    bump: (id) => { revision += 1; for (const l of listeners) l(id); },
    setToken: (t) => { current = t; },
  };
  return oauth;
}

async function rig(opts: { platform?: NodeJS.Platform; token?: string | null } = {}) {
  const up = await upstream();
  let connector: Connector | null = connectorAt(up.url);
  const oauth = fakeOAuth(opts.token === undefined ? VENDOR_TOKEN : opts.token);
  const notice = vi.fn();
  const redact = vi.fn();
  const registry = new WorkerGatewayRegistry({
    oauth: () => oauth,
    connector: () => connector,
    forBot: () => (connector ? [connector] : []),
    taskOpen: () => true,
    botMayRun: () => true,
    notice,
    redact,
    platform: opts.platform ?? 'darwin',
  });
  cleanups.push(() => registry.dispose());
  return { up, oauth, notice, redact, registry, setConnector: (c: Connector | null) => { connector = c; }, connector: () => connector };
}

async function clientFor(url: string, token: string) {
  const client = new Client({ name: 'worker', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  }));
  cleanups.push(() => client.close());
  return client;
}

describe('the bearer env name', () => {
  it('is a credential-shaped secret name the daemon accepts', () => {
    const name = workerGatewayEnvName('con-1a2b3c4d');
    expect(name).toBe('CONNECTOR_1A2B3C4D_TOKEN');
    expect(isBotSecretName(name)).toBe(true);
    expect(sanitizeSecretEnv({ [name]: 'x'.repeat(43) })).toEqual({ [name]: 'x'.repeat(43) });
  });
});

describe('WorkerGatewayRegistry', () => {
  it('serves only the owner\'s listed tools, whatever the upstream labels read-only, and keeps the vendor token in main', async () => {
    const r = await rig();
    const c = r.connector()!;
    const open = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [c] });
    const route = open.routes.notion;
    expect(route.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(route.envName).toBe('CONNECTOR_1A2B3C4D_TOKEN');
    expect(Object.keys(open.env)).toEqual([route.envName]);
    const bearer = open.env[route.envName];
    expect(JSON.stringify({ routes: open.routes })).not.toContain(VENDOR_TOKEN);
    expect(bearer).not.toBe(VENDOR_TOKEN);
    open.bind('daemon-0000aaaa');
    const client = await clientFor(route.url, bearer);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['read_page']);
    expect((await client.callTool({ name: 'delete_page', arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: 'send_mail', arguments: {} })).isError).toBe(true);
    expect(r.up.calls).toEqual([]);
    expect(await client.callTool({ name: 'read_page', arguments: {} })).toMatchObject({ content: [{ text: 'page text' }] });
    expect(r.up.calls).toEqual(['read_page']);
    expect(r.up.auth.every((h) => h === `Bearer ${VENDOR_TOKEN}`)).toBe(true);
    // The live bearer is matched by redaction.
    expect(r.redact).toHaveBeenLastCalledWith([{ name: route.envName, value: bearer }]);
  });

  it('never answers 401 (a worker\'s client never looks for a sign-in) and refuses an unbound lease', async () => {
    const r = await rig();
    const open = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [r.connector()!] });
    const { url } = open.routes.notion;
    const bearer = open.env[open.routes.notion.envName];
    const statuses = [
      (await fetch(url, { method: 'POST', body: '{}' })).status,
      (await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status,
      (await fetch(new URL('/.well-known/oauth-protected-resource', url), { headers: { Authorization: `Bearer ${bearer}` } })).status,
    ];
    expect(statuses).toEqual([403, 403, 403]);
    // Not bound to a pane yet: its calls are refused.
    const client = await clientFor(url, bearer);
    await expect(client.listTools()).rejects.toThrow();
    expect(r.up.calls).toEqual([]);
  });

  it('closes on a create rollback, keeping the bearer redacted', async () => {
    const r = await rig();
    const open = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [r.connector()!] });
    const bearer = open.env[open.routes.notion.envName];
    open.close();
    expect(r.registry.size).toBe(0);
    await expect(fetch(open.routes.notion.url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: '{}' })).rejects.toThrow();
    expect(r.redact).toHaveBeenLastCalledWith([{ name: open.routes.notion.envName, value: bearer }]);
    expect(r.notice).not.toHaveBeenCalled();
  });

  it('closes with its session, and tells the bot when the sign-in changes or the connection does', async () => {
    const r = await rig();
    const a = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [r.connector()!] });
    a.bind('daemon-0000aaaa');
    expect(r.registry.closeSession('daemon-0000bbbb')).toBe(0);
    expect(r.registry.closeSession('daemon-0000aaaa')).toBe(1);
    expect(r.notice).not.toHaveBeenCalled();

    const b = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-2', connectors: [r.connector()!] });
    b.bind('daemon-0000cccc');
    r.oauth.bump('con-1a2b3c4d');
    expect(r.registry.size).toBe(0);
    expect(r.notice).toHaveBeenCalledWith({ botId: 'bot-00000001', taskId: 'wtask-2', connectorName: 'notion', reason: 'signed_out' });

    const c = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-3', connectors: [r.connector()!] });
    c.bind('daemon-0000dddd');
    r.setConnector({ ...r.connector()!, enabled: false });
    expect(r.registry.libraryChanged()).toBe(1);
    expect(r.notice).toHaveBeenLastCalledWith({ botId: 'bot-00000001', taskId: 'wtask-3', connectorName: 'notion', reason: 'changed' });
  });

  it('opens nothing on Windows, without a sign-in, past its cap, or for a connection changed since', async () => {
    const win = await rig({ platform: 'win32' });
    await expect(win.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [win.connector()!] })).rejects.toThrow(/Windows/);
    const signedOut = await rig({ token: null });
    await expect(signedOut.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [signedOut.connector()!] })).rejects.toThrow(/Sign in required/);
    expect(signedOut.registry.size).toBe(0);
    const r = await rig();
    const many = Array.from({ length: WORKER_GATEWAY_LIMITS.LEASES_MAX + 1 }, () => r.connector()!);
    await expect(r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: many })).rejects.toThrow(/at most/);
    await expect(r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [{ ...r.connector()!, updatedAt: 2 }] })).rejects.toThrow(/changed/);
  });

  it('stops the first-list clock only for a list that passed every authorization check', async () => {
    const up = await upstream();
    const connector = connectorAt(up.url);
    const cleared: unknown[] = [];
    const registry = new WorkerGatewayRegistry({
      oauth: () => fakeOAuth(), connector: () => connector, forBot: () => [connector], taskOpen: () => true, botMayRun: () => true,
      platform: 'darwin', redact: () => undefined,
      setTimer: (_fn, ms) => `timer-${ms}`, clearTimer: (h) => { cleared.push(h); },
    });
    cleanups.push(() => registry.dispose());
    const open = await registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [connector] });
    const client = await clientFor(open.routes.notion.url, open.env[open.routes.notion.envName]);
    await expect(client.listTools()).rejects.toThrow();
    expect(cleared).not.toContain(`timer-${WORKER_GATEWAY_LIMITS.FIRST_LIST_MS}`);
    open.bind('daemon-0000aaaa');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['read_page']);
    expect(cleared).toContain(`timer-${WORKER_GATEWAY_LIMITS.FIRST_LIST_MS}`);
  });

  it('closes a lease no tools/list reached in time, quietly', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const r = await rig();
      const open = await r.registry.open({ botId: 'bot-00000001', taskId: 'wtask-1', connectors: [r.connector()!] });
      open.bind('daemon-0000aaaa');
      vi.advanceTimersByTime(WORKER_GATEWAY_LIMITS.FIRST_LIST_MS + 1);
      expect(r.registry.size).toBe(0);
      expect(r.notice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('accepting a task with signed-in connections', () => {
  const c = connectorAt('https://mcp.example.com/mcp');

  it('routes only the connections with a stored sign-in, and refuses one it cannot read or a catalog service never signed in', () => {
    const plain = { ...c, id: 'con-00000002', name: 'plain' };
    const stdio: Connector = { ...c, id: 'con-00000003', name: 'files', transport: 'stdio', remote: undefined, stdio: { command: '/bin/x', args: [], env: {} } };
    const oauth = { hasRecord: (id: string) => id === c.id };
    expect(gatewayConnectorsOf([c, plain, stdio], oauth)).toEqual({ gateway: [c] });
    expect(gatewayConnectorsOf([c], { hasRecord: () => 'unknown' })).toHaveProperty('refusal');
    expect(gatewayConnectorsOf([c], null)).toEqual({ gateway: [] });
    // A sign-in service of the catalog with no sign-in is never sent directly.
    const notion = { ...c, id: 'con-00000004', name: 'notion', remote: { url: 'https://mcp.notion.com/mcp', headers: {} } };
    expect(isSignInService(notion)).toBe(true);
    expect(isSignInService({ ...notion, secrets: [{ secret: 'X_TOKEN', as: 'header' as const, header: 'Authorization', scheme: 'bearer' as const }] })).toBe(false);
    expect(gatewayConnectorsOf([notion], { hasRecord: () => false })).toEqual({ refusal: expect.stringMatching(/not signed in/) });
    expect(gatewayConnectorsOf([notion], null)).toHaveProperty('refusal');
  });

  it('takes them only on macOS and Linux, all signed in, from a clean wake and conversation, as research, with tools picked', () => {
    const ok = { connectors: [c], all: [c], platform: 'darwin' as const, preset: 'research', wakeTainted: false, conversationTainted: false };
    expect(gatewayShapeRefusal(ok)).toBeNull();
    expect(gatewayShapeRefusal({ ...ok, platform: 'win32' })).toMatch(/Windows/);
    const files: Connector = { ...c, id: 'con-00000003', name: 'files', transport: 'stdio', remote: undefined, stdio: { command: '/bin/x', args: [], env: {} } };
    expect(gatewayShapeRefusal({ ...ok, all: [c, files] })).toMatch(/only signed-in connections.*files/);
    expect(gatewayShapeRefusal({ ...ok, wakeTainted: true })).toMatch(/outside text/);
    expect(gatewayShapeRefusal({ ...ok, conversationTainted: true })).toMatch(/conversation/);
    expect(gatewayShapeRefusal({ ...ok, preset: 'default' })).toMatch(/research/);
    expect(gatewayShapeRefusal({ ...ok, preset: undefined })).toMatch(/research/);
    expect(gatewayShapeRefusal({ ...ok, connectors: [{ ...c, tools: { mode: 'all', blocked: [] } }], all: [] })).toMatch(/tools/);
    expect(gatewayShapeRefusal({ ...ok, connectors: [{ ...c, tools: { mode: 'listed', allowed: [] } }], all: [] })).toMatch(/tools/);
    expect(gatewayShapeRefusal({ ...ok, connectors: [], all: [files] })).toBeNull();
  });

  it('needs a sign-in that refreshes now, read-only tools as the service marks them, and the command sandbox', async () => {
    const sandboxOk = async () => ({ ok: true as const });
    const readOnly = vi.fn(async () => ({ status: 'ready' as const, toolCount: 2, toolNames: ['read_page', 'delete_page'], readOnlyToolNames: ['read_page'], checkedAt: 1 }));
    const base = { connectors: [c], sandbox: sandboxOk, listTools: readOnly };
    expect(await gatewayReadyRefusal({ ...base, oauth: fakeOAuth() })).toBeNull();
    expect(readOnly).toHaveBeenCalledWith(c, { Authorization: `Bearer ${VENDOR_TOKEN}` });
    expect(await gatewayReadyRefusal({ ...base, oauth: fakeOAuth(null) })).toMatch(/sign in again/);
    expect(await gatewayReadyRefusal({ ...base, oauth: { ...fakeOAuth(), awaitingConsent: () => true } })).toMatch(/waiting/);
    expect(await gatewayReadyRefusal({ ...base, oauth: fakeOAuth(), sandbox: async () => ({ ok: false, reason: 'macOS sandbox-exec is missing' }) })).toMatch(/sandbox-exec/);
    expect(await gatewayReadyRefusal({ ...base, oauth: null })).toMatch(/not running/);
    // A picked tool the service does not mark read-only (or a list that cannot be read).
    const picksWrite = { ...c, tools: { mode: 'listed' as const, allowed: ['read_page', 'delete_page'] } };
    expect(await gatewayReadyRefusal({ ...base, connectors: [picksWrite], oauth: fakeOAuth() })).toMatch(/read-only.*delete_page/);
    expect(await gatewayReadyRefusal({ ...base, oauth: fakeOAuth(), listTools: async () => ({ status: 'timeout' as const }) })).toMatch(/could not be listed/);
  });
});

describe('the worker sandbox and the bot notices', () => {
  it('denies the network and unsets the bearer for the worker\'s commands', () => {
    const sandbox = workerGatewaySandbox({ cwd: '/tmp/research/t1', tmpDir: '/tmp/wtmp/t1', wmuxDir: '/home/u/.wmux', env: { PATH: '/usr/bin', CONNECTOR_1A2B3C4D_TOKEN: '', GH_TOKEN: 'x' } }) as {
      enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean;
      network: { deniedDomains: string[]; allowedDomains: string[]; allowUnixSockets: string[]; allowLocalBinding: boolean };
      filesystem: { allowWrite: string[]; allowRead: string[]; denyWrite: string[] };
      credentials: { envVars: Array<{ name: string; mode: string }> };
    };
    expect(sandbox.enabled && sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.network).toMatchObject({ allowedDomains: [], deniedDomains: ['*'], allowUnixSockets: [], allowLocalBinding: false });
    const dirs = [path.resolve('/tmp/research/t1'), path.resolve('/tmp/wtmp/t1')];
    expect(sandbox.filesystem.allowWrite).toEqual(dirs);
    expect(sandbox.filesystem.allowRead).toEqual(dirs);
    expect(sandbox.filesystem.denyWrite).toEqual(['.claude', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md'].map((n) => path.join(dirs[0], n)));
    const unset = sandbox.credentials.envVars.map((v) => v.name);
    expect(unset).toContain('CONNECTOR_1A2B3C4D_TOKEN');
    expect(unset).toContain('GH_TOKEN');
    expect(unset).not.toContain('PATH');
  });

  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: 'wtask-1', status: 'working', title: 'Read the page', ownerWorkspaceId: 'ws-1', taskWorkspaceId: 'ws-t',
    dispatch: { origin: { kind: 'bot', botId: 'bot-00000001', tainted: true, guest: false }, connectors: ['notion'], gatewayConnectors: ['notion'] },
    ...over,
  } as unknown as LedgerEntry);

  it('tells an open task\'s bot to sign in again and resume, never an ended one', () => {
    const n = gatewayLossNotice(entry(), 'notion', 'signed_out', 5);
    expect(n).toMatchObject({ botId: 'bot-00000001', workspaceId: 'ws-1', topic: 'worker.connection_lost', card: true, taskId: 'wtask-1' });
    expect(n?.title).toBe('notion was disconnected; sign in again if needed, then resume the worker');
    expect(gatewayLossNotice(entry({ status: 'completed' }), 'notion', 'expired', 5)).toBeNull();
  });

  it('finds the open tasks a restart of main cut off', () => {
    const rows = [
      entry(),
      entry({ id: 'wtask-2', status: 'failed' }),
      entry({ id: 'wtask-3', dispatch: { origin: { kind: 'bot', botId: 'bot-00000001', tainted: true, guest: false }, connectors: ['github'] } } as Partial<LedgerEntry>),
    ];
    expect(gatewayTasksCutByRestart(rows).map((x) => [x.entry.id, x.names])).toEqual([['wtask-1', ['notion']]]);
  });
});
