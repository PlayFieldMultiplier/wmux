import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTerminalGateway } from '../terminalGateway';
import type { Connector } from '../../../shared/botConnector';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(ttlMs?: number) {
  const calls: string[] = []; const headers: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    headers.push(req.headers.authorization ?? '');
    if (!('id' in message)) { res.writeHead(202); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: ['read', 'write'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (message.method === 'tools/call') { calls.push(message.params.name); result = { content: [{ type: 'text', text: 'fixture result' }] }; }
    else result = {};
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let revision = 0;
  let connector: Connector | undefined = { id: 'con-12345678', name: 'test-service', transport: 'http', remote: { url: endpoint, headers: {} }, secrets: [], tools: { mode: 'listed', allowed: ['read'] }, scope: { kind: 'bots', botIds: [] }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
  const gateway = await createTerminalGateway({ ttlMs, getConnector: () => connector, headers: async () => ({ Authorization: 'Bearer upstream-secret' }), authorizationRevision: () => revision });
  cleanups.push(gateway.close);
  const client = new Client({ name: 'test-cli', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), { requestInit: { headers: { Authorization: `Bearer ${gateway.token}` } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } }));
  cleanups.push(() => client.close());
  return { client, gateway, calls, headers, remove: () => { connector = undefined; }, revoke: () => { revision++; } };
}
it('exposes and executes only selected tools, retaining upstream credentials in main', async () => {
  const f = await fixture();
  expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(['read']);
  expect((await f.client.callTool({ name: 'write', arguments: {} })).isError).toBe(true);
  expect(f.calls).toEqual([]);
  const result = await f.client.callTool({ name: 'read', arguments: {} });
  expect(result).toMatchObject({ content: [{ text: 'fixture result' }] });
  expect(f.calls).toEqual(['read']);
  expect(f.headers.every((h) => h === 'Bearer upstream-secret')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('upstream-secret');
  expect(f.gateway.url).not.toContain('upstream-secret');
});
it('rejects browser-origin and wrong capability requests', async () => {
  const f = await fixture();
  expect((await fetch(f.gateway.url, { method: 'POST', body: '{}' })).status).toBe(403);
  expect((await fetch(f.gateway.url, { method: 'POST', headers: { Origin: 'https://example.com', Authorization: `Bearer ${f.gateway.token}` }, body: '{}' })).status).toBe(403);
  expect((await fetch(new URL('/wrong', f.gateway.url), { method: 'POST', body: '{}' })).status).toBe(403);
});
it('stops serving a removed connection or revoked authorization', async () => {
  for (const remove of [false, true]) {
    const f = await fixture();
    if (remove) f.remove(); else f.revoke();
    await expect(f.client.listTools()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  }
});

it('expires the local capability without requiring agent cooperation', async () => {
  const f = await fixture(1000);
  await vi.waitFor(async () => {
    await expect(fetch(f.gateway.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  }, { timeout: 5000 });
});
it('does not accept another terminal session bearer even for the same connection', async () => {
  const first = await fixture(); const second = await fixture();
  expect(first.gateway.token).not.toBe(second.gateway.token);
  expect((await fetch(first.gateway.url, { method: 'POST', headers: { Authorization: `Bearer ${second.gateway.token}` }, body: '{}' })).status).toBe(403);
  expect(first.calls).toEqual([]);
});
