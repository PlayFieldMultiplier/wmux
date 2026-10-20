// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ServiceConnect from '../ServiceConnect';
import type { ConnectorSaveRequest, ConnectorView } from '../../../../shared/botConnector';
import { CONNECTOR_SERVICES } from '../../../../shared/connectorServices';
import type { BotConnectorPort } from '../../Room/botConnectors';
import { en } from '../../../i18n/locales/en';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
const service = CONNECTOR_SERVICES.find((item) => item.id === 'notion')!;
async function mount(existing = false, refuse = false, disabled = false) {
  const connector: ConnectorView = { id: 'con-12345678', name: 'notion', transport: 'http', remote: { url: service.url, headers: {} }, secrets: [], enabled: !disabled, tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] }, offFor: [], missingKeys: [], createdAt: 1, updatedAt: 1 };
  const save = vi.fn(async (request: ConnectorSaveRequest) => ({ ok: true, connector: { ...connector, ...request.connector } }));
  const port = { available: true, list: vi.fn(async () => refuse ? { ok: false } : { ok: true, connectors: existing ? [connector] : [] }), save } as unknown as BotConnectorPort;
  const action = vi.fn(async (value: string) => ({ status: value === 'connect' ? 'authorized' : 'signed-out' }));
  const check = vi.fn(async () => ({ status: 'ready', toolCount: 2, toolNames: ['read', 'write'] }));
  vi.stubGlobal('electronAPI', { connectorOAuth: { action }, connectorChecks: { check } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ServiceConnect service={service} port={port} disabled={false} />));
  return { save, action, check, port, connector };
}
it('one explicit click saves a restricted connection, starts sign-in and checks after authorization', async () => {
  const { save, action, check } = await mount();
  expect(save).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  await act(async () => { const button = host.querySelector('button')!; button.click(); button.click(); });
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith({ connector: expect.objectContaining({ enabled: true, tools: { mode: 'listed', allowed: [] }, scope: { kind: 'bots', botIds: [] } }) });
  expect(action.mock.calls.filter(([value]) => value === 'connect')).toHaveLength(1);
  expect(check).toHaveBeenCalledWith('con-12345678');
  expect(host.textContent).toContain('Connected and checked');
  expect(host.querySelector('input')).toBeNull();
});
it('reuses an existing endpoint without changing its access policy', async () => {
  const { save, action } = await mount(true);
  await act(async () => host.querySelector('button')!.click());
  expect(save).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledWith('connect', 'con-12345678');
});
it('never starts sign-in or claims success when secure storage refuses the listing', async () => {
  const { save, action, check } = await mount(false, true);
  await act(async () => host.querySelector('button')!.click());
  expect(save).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not start');
});
it('ignores a late connection check after disconnect', async () => {
  const { check } = await mount();
  let finish!: (value: { status: string; toolCount: number; toolNames: string[] }) => void;
  check.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => host.querySelector('button')!.click());
  const disconnect = [...host.querySelectorAll('button')].find((button) => button.textContent === en['connectors.oauth.disconnect'])!;
  await act(async () => disconnect.click());
  await act(async () => finish({ status: 'ready', toolCount: 2, toolNames: ['read', 'write'] }));
  expect(host.textContent).not.toContain('Connected and checked');
});
it('directs a disabled existing connection to review without signing in or enabling it', async () => {
  const { save, action, check } = await mount(true, false, true);
  await act(async () => host.querySelector('button')!.click());
  expect(save).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Open Installed');
  expect(host.querySelector('button')).toBeNull();
});
it('chooses a free name when a different endpoint already uses the service name', async () => {
  const { save, port, connector } = await mount();
  vi.mocked(port.list).mockResolvedValue({ ok: true, connectors: [{ ...connector, remote: { url: 'https://example.com/mcp', headers: {} } }] });
  await act(async () => host.querySelector('button')!.click());
  expect(save).toHaveBeenCalledWith({ connector: expect.objectContaining({ name: 'notion-2' }) });
});
it('does not pass a key-based existing connection into browser sign-in', async () => {
  const { save, action, port, connector } = await mount();
  vi.mocked(port.list).mockResolvedValue({ ok: true, connectors: [{ ...connector, remote: { url: service.url, headers: { Authorization: 'configured' } } }] });
  await act(async () => host.querySelector('button')!.click());
  expect(save).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Open Installed');
});
