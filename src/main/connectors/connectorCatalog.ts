import { parseConnectorCatalog, type ConnectorCatalogResult } from '../../shared/connectorCatalog';

/** Only the public registry is fetched. No account, workspace or keys are sent. */
export async function fetchConnectorCatalog(search: unknown, cursor: unknown, fetcher: typeof fetch = fetch): Promise<ConnectorCatalogResult> {
  if (typeof search !== 'string' || search.length > 128 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))) return { ok: false };
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '30');
  if (search.trim()) url.searchParams.set('search', search.trim());
  if (typeof cursor === 'string' && cursor) url.searchParams.set('cursor', cursor);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!response.ok || !response.body) return { ok: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    let next = await reader.read();
    while (!next.done) {
      bytes += next.value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); return { ok: false }; }
      body += decoder.decode(next.value, { stream: true });
      next = await reader.read();
    }
    body += decoder.decode();
    return parseConnectorCatalog(JSON.parse(body));
  } catch { return { ok: false }; }
  finally { clearTimeout(timer); controller.abort(); }
}
