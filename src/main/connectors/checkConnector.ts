import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Connector } from '../../shared/botConnector';
import { isConnectorUrl } from '../../shared/botConnector';
import type { ConnectorCheckResult } from '../../shared/connectorCheck';

/** HTTP discovery only: never launch a stdio executable or call a tool. */
export async function checkConnector(
  connector: Connector,
  headers: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<ConnectorCheckResult> {
  if (connector.transport !== 'http') return { status: 'unsupported' };
  if (!connector.remote || !isConnectorUrl(connector.remote.url)) return { status: 'failed' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const url = new URL(connector.remote.url);
  const client = new Client({ name: 'wmux-connector-check', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    fetch: async (input, init) => {
      // Never follow redirects with a connection's stored headers. The SDK's
      // HTTP transport only needs this endpoint for initialization/discovery.
      if (new URL(input instanceof Request ? input.url : String(input)).href !== url.href) throw new Error('Unexpected endpoint');
      const response = await fetch(input, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          bytes += chunk.byteLength;
          if (bytes > 2 * 1024 * 1024) { stream.error(new Error('Discovery response too large')); return; }
          stream.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const names = new Set<string>();
    const readOnly = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 16; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal: controller.signal, timeout: timeoutMs });
      for (const tool of result.tools) {
        if (tool.name.length > 128 || names.size >= 1024) return { status: 'failed' };
        names.add(tool.name);
        if (tool.annotations?.readOnlyHint === true) readOnly.add(tool.name);
      }
      cursor = result.nextCursor;
      if (!cursor) return { status: 'ready', toolCount: names.size, toolNames: [...names], readOnlyToolNames: [...readOnly], checkedAt: Date.now() };
      if (cursors.has(cursor)) return { status: 'failed' };
      cursors.add(cursor);
    }
    return { status: 'failed' };
  } catch (error) {
    if (timedOut) return { status: 'timeout' };
    if (error instanceof UnauthorizedError || (error && typeof error === 'object' && 'code' in error && (error.code === 401 || error.code === 403))) return { status: 'auth-required' };
    // Do not return/log server error bodies, endpoints, or credential values.
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    await client.close().catch(() => undefined);
  }
}
