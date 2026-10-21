import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Connector } from '../../shared/botConnector';
import { isConnectorUrl } from '../../shared/botConnector';

interface Options {
  getConnector: () => Connector | undefined;
  headers: () => Promise<Record<string, string>>;
  authorizationRevision: () => number;
  /** Host-bound live session and policy check. Never derived from MCP params. */
  authorize: () => Promise<void>;
  ttlMs?: number;
  /** The MCP client name upstream sees (default: the terminal's). */
  clientName?: string;
  /** Told once a tools/list reached the gateway (a bot worker's lease
   *  clock, main/connectors/workerGateway.ts). */
  onListTools?: () => void;
}
/** One explicitly selected HTTP connection. Credentials never enter CLI configuration. */
export async function createTerminalGateway(options: Options): Promise<{ url: string; token: string; close: () => void }> {
  const selected = options.getConnector();
  if (!selected?.enabled || selected.transport !== 'http' || !selected.remote || !isConnectorUrl(selected.remote.url)) throw new Error('Connection unavailable');
  const snapshot = JSON.stringify(selected);
  const revision = options.authorizationRevision();
  const valid = () => {
    if (closed || JSON.stringify(options.getConnector()) !== snapshot || options.authorizationRevision() !== revision) throw new Error('Connection changed');
  };
  const permits = (name: string) => selected.tools.mode === 'all' ? !selected.tools.blocked.includes(name) : selected.tools.allowed.includes(name);
  const endpoint = selected.remote.url;
  const token = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = new Set<AbortController>();
  const servers = new Set<Server>();
  let closed = false;
  let host = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    closed = true; clearTimeout(timer);
    for (const controller of active) controller.abort();
    for (const server of servers) void server.close().catch(() => undefined);
    http.closeAllConnections(); http.close();
  };
  const upstream = async <T>(work: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> => {
    valid();
    await options.authorize(); valid();
    const controller = new AbortController(); active.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const client = new Client({ name: options.clientName ?? 'wmux-terminal-connector', version: '1.0.0' });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
        fetch: async (input, init) => {
          valid();
          if (new URL(input instanceof Request ? input.url : String(input)).href !== new URL(endpoint).href) throw new Error('Unexpected endpoint');
          const credentials = await options.headers(); valid();
          await options.authorize(); valid();
          const headers = new Headers(init?.headers);
          for (const [name, value] of Object.entries(credentials)) headers.set(name, value);
          const response = await fetch(input, { ...init, headers, redirect: 'error', signal: controller.signal });
          if (!response.body) return response;
          let size = 0;
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, sink) {
            size += chunk.byteLength;
            if (size > 4 * 1024 * 1024) { sink.error(new Error('Response too large')); return; }
            sink.enqueue(chunk);
          } }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
      });
      await client.connect(transport, { timeout: 15_000 });
      valid();
      const result = await work(client, controller.signal);
      await options.authorize(); valid(); return result;
    } finally { clearTimeout(timeout); controller.abort(); active.delete(controller); await client.close().catch(() => undefined); }
  };
  const http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (closed || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization) || req.headers.host !== host || req.url !== '/mcp' || req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (servers.size >= 4) { res.writeHead(429); res.end(); return; }
    const server = new Server({ name: 'wmux-connector', version: '1.0.0' }, { capabilities: { tools: {} } });
    servers.add(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const clean = () => { servers.delete(server); void server.close().catch(() => undefined); };
    res.once('close', clean);
    try {
      valid();
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Request too large'); chunks.push(Buffer.from(chunk)); }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        try { options.onListTools?.(); } catch { /* a clock never blocks the list */ }
        try {
          return await upstream(async (client, signal) => {
            const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
            let cursor: string | undefined; const cursors = new Set<string>();
            for (let page = 0; page < 16; page++) {
              const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15_000 });
              tools.push(...result.tools.filter((t) => permits(t.name)));
              if (tools.length > 1024) throw new Error('Too many tools');
              cursor = result.nextCursor;
              if (!cursor) return { tools };
              if (cursors.has(cursor)) break;
              cursors.add(cursor);
            }
            throw new Error('Too many pages');
          });
        } catch { throw new Error('Connector unavailable. Check its authorization and configuration in wmux.'); }
      });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (!permits(request.params.name)) return { isError: true, content: [{ type: 'text', text: 'This tool is not permitted for this connection.' }] };
        try { return await upstream((client, signal) => client.callTool(request.params, undefined, { signal, timeout: 60_000 })); }
        catch { return { isError: true, content: [{ type: 'text', text: 'Connector request failed. Check wmux before retrying; the operation may already have reached the service.' }] }; }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, request);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); clean(); }
  });
  http.headersTimeout = 5000; http.requestTimeout = 65_000;
  try {
    await new Promise<void>((yes, no) => { http.once('error', no); http.listen(0, '127.0.0.1', yes); });
    host = `127.0.0.1:${(http.address() as AddressInfo).port}`;
    timer = setTimeout(close, options.ttlMs ?? 3600_000); timer.unref();
    return { url: `http://${host}/mcp`, token, close };
  } catch (error) { close(); throw error; }
}
