import { isConnectorUrl, type ConnectorDraft } from './botConnector';

export const CONNECTOR_CATALOG_IPC = 'connectors:catalog';
export interface ConnectorCatalogEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  repository?: string;
  remotes: Array<{ type: 'http' | 'sse'; url: string }>;
}
export type ConnectorCatalogResult =
  | { ok: true; entries: ConnectorCatalogEntry[]; nextCursor?: string }
  | { ok: false };

const record = (x: unknown): Record<string, unknown> | null => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
const text = (x: unknown, max: number): string => typeof x === 'string' ? x.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, '') : ''; // eslint-disable-line no-control-regex

/** Registry data is descriptive, never executable configuration or proof of trust. */
export function parseConnectorCatalog(raw: unknown): ConnectorCatalogResult {
  const page = record(raw);
  if (!page || !Array.isArray(page.servers)) return { ok: false };
  const entries: ConnectorCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const item of page.servers.slice(0, 100)) {
    const row = record(item);
    const server = record(row?.server);
    const status = record(record(row?._meta)?.['io.modelcontextprotocol.registry/official']);
    if (!server || status?.status !== 'active' || status.isLatest === false) continue;
    const id = text(server.name, 256);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const remotes: ConnectorCatalogEntry['remotes'] = [];
    for (const item of Array.isArray(server.remotes) ? server.remotes.slice(0, 16) : []) {
      const remote = record(item);
      const url = remote?.url;
      if ((remote?.type !== 'streamable-http' && remote?.type !== 'sse') || !isConnectorUrl(url) || /[{}]/.test(url)) continue;
      remotes.push({ type: remote.type === 'sse' ? 'sse' : 'http', url });
    }
    const repository = text(record(server.repository)?.url, 2048);
    entries.push({ id, title: text(server.title, 128) || id, description: text(server.description, 512), version: text(server.version, 64), remotes,
      ...(repository.startsWith('https://') && isConnectorUrl(repository) ? { repository } : {}),
    });
  }
  const cursor = record(page.metadata)?.nextCursor;
  return { ok: true, entries, ...(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048 ? { nextCursor: cursor } : {}) };
}

/** Explicit review starts disabled, with no bot scope or allowed tools. */
export function catalogConnectorDraft(entry: ConnectorCatalogEntry, index: number): ConnectorDraft | null {
  const endpoint = entry.remotes[index];
  if (!endpoint || !isConnectorUrl(endpoint.url)) return null;
  let hash = 2166136261;
  for (const char of entry.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const slug = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = `c-${slug || 'server'}`.slice(0, 23).replace(/-+$/, '') + '-' + (hash >>> 0).toString(16).padStart(8, '0');
  return { name, purpose: entry.title.slice(0, 120), transport: endpoint.type, remote: { url: endpoint.url, headers: {} },
    secrets: [], tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] }, enabled: false };
}
