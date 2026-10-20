// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConnectorsPage from '../ConnectorsPage';
import { en } from '../../../i18n/locales/en';
import type { BotConnectorPort } from '../../Room/botConnectors';
import type { ConnectorView } from '../../../../shared/botConnector';
import { normalizeUrl } from '../../../../shared/connectorUrl';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
vi.mock('../../Room/useFactoryBots', () => ({ useFactoryBots: () => [] }));
vi.mock('../../Room/factoryPorts', () => ({ getFactoryBotPort: () => ({ subscribe: () => () => undefined }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const c: ConnectorView = { id: 'con-00000001', name: 'example', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} }, secrets: [], tools: { mode: 'listed', allowed: ['read'] }, scope: { kind: 'all' }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1, missingKeys: [] };
const port = (): BotConnectorPort => ({ available: true, list: vi.fn(async () => ({ ok: true as const, connectors: [c] })), save: vi.fn(), remove: vi.fn(async () => ({ ok: true as const, deletedKeys: [], keptKeys: [] })), setOffForBot: vi.fn(), setEnabled: vi.fn(async () => ({ ok: true as const, connector: c })) });
let root: Root;
let host: HTMLDivElement;
async function mount(p: BotConnectorPort) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<ConnectorsPage port={p} />)); }
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function button(name: string): HTMLButtonElement { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === name); if (!b) throw new Error(`Missing ${name}`); return b; }
describe('Connectors page', () => {
  it('keeps configured separate from authenticated and uses English labels', async () => {
    await mount(port());
    expect(host.textContent).toContain('Configured · not verified');
    expect(host.textContent).toContain('local macOS/Linux terminal launch commands');
    expect(host.textContent).not.toContain('Connected');
  });
  it('requires confirmation and preserves stored keys on remove', async () => {
    const p = port(); await mount(p);
    await act(async () => button('Remove').click());
    expect(p.remove).not.toHaveBeenCalled();
    await act(async () => button('Remove connection').click());
    expect(p.remove).toHaveBeenCalledWith({ id: c.id, deleteKeys: false });
  });
  it('shows a retryable error instead of pretending a failed read is empty', async () => {
    const p = port(); p.list = vi.fn().mockRejectedValue(new Error('offline')); await mount(p);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('Add connector').disabled).toBe(true);
    p.list = vi.fn(async () => ({ ok: true as const, connectors: [c] }));
    await act(async () => button('Retry').click());
    expect(host.textContent).toContain('example');
  });
  it('opens a catalog preset for review without saving it', async () => {
    const p = port(); await mount(p);
    await act(async () => button('Discover').click());
    await act(async () => button('Configure').click());
    expect(p.save).not.toHaveBeenCalled();
    expect((document.querySelector('[data-testid="connection-url"]') as HTMLInputElement).value).toContain('api.githubcopilot.com');
  });
  it('shows server checks separately from stored configuration', async () => {
    const check = vi.fn(async () => ({ status: 'auth-required' }));
    vi.stubGlobal('electronAPI', { connectorChecks: { check } });
    await mount(port());
    await act(async () => button('Check server').click());
    expect(check).toHaveBeenCalledWith(c.id);
    expect(host.textContent).toContain('Authentication required');
    expect(host.textContent).toContain('Configured · not verified');
  });
  it('normalizes addresses without hiding explicit unsupported protocols', () => {
    expect(normalizeUrl(' example.com/mcp ')).toBe('https://example.com/mcp');
    expect(normalizeUrl('http://127.0.0.1:3000/mcp')).toBe('http://127.0.0.1:3000/mcp');
    expect(normalizeUrl('file:///tmp/a')).toBe('file:///tmp/a');
    expect(normalizeUrl('  ')).toBe('');
  });
});
