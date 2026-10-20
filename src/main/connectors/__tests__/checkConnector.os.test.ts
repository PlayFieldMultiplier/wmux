import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkConnector } from '../checkConnector';
import type { Connector } from '../../../shared/botConnector';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); } });
async function serve(mode: 'ok' | 'auth' | 'redirect' | 'slow' | 'cycle' | 'large' = 'ok') {
  const methods: string[] = [];
  const headers: Array<string | undefined> = [];
  const s = createServer(async (req, res) => {
    if (mode === 'slow') return;
    if (mode === 'auth') { res.writeHead(401); res.end('secret must not appear in the result'); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const msg = JSON.parse(text);
    methods.push(msg.method); headers.push(req.headers.authorization);
    if (!('id' in msg)) { res.writeHead(202); res.end(); return; }
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
      : { tools: [{ name: 'read_mail', inputSchema: { type: 'object' } }], ...(mode === 'cycle' ? { nextCursor: 'repeat' } : {}) };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end((mode === 'large' ? ' '.repeat(3 * 1024 * 1024) : '') + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  servers.push(s); await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const c: Connector = { id: 'con-00000001', name: 'test', transport: 'http', remote: { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`, headers: {} }, secrets: [], tools: { mode: 'all', blocked: [] }, scope: { kind: 'all' }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
  return { c, methods, headers };
}
describe('MCP connector discovery against a live local HTTP server', () => {
  it('initializes and lists tools without executing a tool', async () => {
    const { c, methods, headers } = await serve();
    const r = await checkConnector(c, { Authorization: 'Bearer local-test-only' });
    expect(r).toMatchObject({ status: 'ready', toolCount: 1 });
    expect(methods).toContain('initialize'); expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call'); expect(headers).toContain('Bearer local-test-only');
  });
  it('reports authentication without reflecting server text', async () => {
    expect(await checkConnector((await serve('auth')).c, {})).toEqual({ status: 'auth-required' });
  });
  it('does not follow a credential-bearing redirect', async () => {
    expect(await checkConnector((await serve('redirect')).c, { Authorization: 'Bearer private' })).toEqual({ status: 'failed' });
  });
  it('bounds a hung server and closes the session', async () => {
    expect(await checkConnector((await serve('slow')).c, {}, undefined, 100)).toEqual({ status: 'timeout' });
  });
  it('rejects repeating pagination rather than reporting partial success', async () => {
    expect(await checkConnector((await serve('cycle')).c, {})).toEqual({ status: 'failed' });
  });
  it('bounds response bytes before JSON parsing', async () => {
    expect(await checkConnector((await serve('large')).c, {})).toEqual({ status: 'failed' });
  });
  it('never launches a configured stdio command for a check', async () => {
    const { c } = await serve(); expect(await checkConnector({ ...c, transport: 'stdio' }, {})).toEqual({ status: 'unsupported' });
  });
});
