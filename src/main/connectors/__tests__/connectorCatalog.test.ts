import { describe, expect, it, vi } from 'vitest';
import { fetchConnectorCatalog } from '../connectorCatalog';
import { catalogConnectorDraft, parseConnectorCatalog } from '../../../shared/connectorCatalog';
const row = (name: string, extra = {}, status = 'active') => ({ server: { name, title: name, version: '1', ...extra }, _meta: { 'io.modelcontextprotocol.registry/official': { status, isLatest: true } } });
describe('public connector catalog', () => {
  it('keeps local-only listings but strips executable configuration and unsafe endpoints', () => {
    const result = parseConnectorCatalog({ servers: [row('local', { packages: [{ command: 'evil' }] }), row('remote', { remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }, { type: 'sse', url: 'https://example.com/{tenant}' }, { type: 'streamable-http', url: 'http://example.com' }] }), row('remote'), row('deleted', {}, 'deleted')] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((x) => x.id)).toEqual(['local', 'remote']);
    expect(result.entries[0].remotes).toEqual([]);
    expect(catalogConnectorDraft(result.entries[0], 0)).toBeNull();
    expect(result.entries[1].remotes).toEqual([{ type: 'http', url: 'https://example.com/mcp' }]);
    expect(catalogConnectorDraft(result.entries[1], 0)).toMatchObject({ enabled: false, secrets: [], tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] }, remote: { headers: {} } });
    expect(JSON.stringify(result)).not.toContain('evil');
  });
  it('rejects malformed pages and obsolete versions', () => {
    expect(parseConnectorCatalog({})).toEqual({ ok: false });
    const old = row('old'); old._meta['io.modelcontextprotocol.registry/official'].isLatest = false;
    expect(parseConnectorCatalog({ servers: [old] })).toEqual({ ok: true, entries: [] });
  });
  it('fetches only the fixed registry with encoded search/cursor and no credentials or redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ servers: [row('calendar')], metadata: { nextCursor: 'next' } })));
    expect(await fetchConnectorCatalog('calendar&limit=100', 'https://attacker.test', fetcher)).toMatchObject({ ok: true, nextCursor: 'next' });
    const [url, options] = fetcher.mock.calls[0];
    expect(new URL(String(url)).origin).toBe('https://registry.modelcontextprotocol.io');
    expect(new URL(String(url)).searchParams.get('search')).toBe('calendar&limit=100');
    expect(new URL(String(url)).searchParams.get('version')).toBe('latest');
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
  });
  it('handles invalid input, malformed data, failed requests and oversized pages', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await fetchConnectorCatalog('x'.repeat(129), undefined, fetcher)).toEqual({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('invalid')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    for (let i = 0; i < 3; i++) expect(await fetchConnectorCatalog('', undefined, fetcher)).toEqual({ ok: false });
  });
});
