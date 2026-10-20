import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ConnectorOAuth } from '../../../connectors/connectorOAuth';
import type { Connector } from '../../../../shared/botConnector';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), remove: vi.fn(), get: vi.fn(), values: vi.fn(), gateway: vi.fn(), close: vi.fn() }));
vi.mock('../../../../daemon/config', () => ({ getWmuxDir: () => '/unused' }));
vi.mock('../../../connectors/terminalLaunch', () => ({ createTerminalLaunch: () => ({ command: '/private/launch', close: () => undefined }) }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.remove } }));
vi.mock('../../../factory/connectorStore', () => ({ getConnectorStore: () => ({ get: mocks.get }) }));
vi.mock('../../../factory/secretStore', () => ({ getSecretStore: () => ({ values: mocks.values }) }));
vi.mock('../../../connectors/terminalGateway', () => ({ createTerminalGateway: mocks.gateway }));
import { registerConnectorTerminalHandlers } from '../connectorTerminal.handler';
const connector: Connector = { id: 'con-12345678', name: 'test-service', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} }, secrets: [{ secret: 'API_KEY', as: 'header', header: 'Authorization', scheme: 'bearer' }], tools: { mode: 'listed', allowed: ['read'] }, scope: { kind: 'bots', botIds: [] }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
let cleanup: () => void;
afterEach(() => { cleanup?.(); vi.resetAllMocks(); });
function setup() {
  const frame = {}; const sender = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
  mocks.get.mockReturnValue(connector);
  mocks.values.mockReturnValue({ ok: true, env: { API_KEY: 'do-not-expose' } });
  mocks.gateway.mockResolvedValue({ url: `http://127.0.0.1:1234/${'a'.repeat(43)}`, close: mocks.close });
  const oauth = { status: () => ({ status: 'unavailable' }), revision: () => 0 } as unknown as ConnectorOAuth;
  cleanup = registerConnectorTerminalHandlers(() => window, oauth);
  return { event: { sender, senderFrame: frame }, invoke: mocks.handle.mock.calls[0][1] };
}
it('rejects foreign frames and invalid selection before reading keys', async () => {
  const { event, invoke } = setup();
  expect(await invoke({ ...event, senderFrame: {} }, connector.id, 'claude')).toEqual({ ok: false });
  expect(await invoke(event, '../x', 'claude')).toEqual({ ok: false });
  expect(await invoke(event, connector.id, 'sh')).toEqual({ ok: false });
  expect(mocks.values).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('keeps credentials main-side and adds an isolated server without replacing global config', async () => {
  const { event, invoke } = setup();
  const result = await invoke(event, connector.id, 'claude');
  expect(result.ok).toBe(true);
  expect(result.command).toBe('/private/launch');
  expect(result.command).not.toMatch(/do-not-expose|strict-mcp-config|skip-permissions/);
  expect(await mocks.gateway.mock.calls[0][0].headers()).toEqual({ Authorization: 'Bearer do-not-expose' });
  cleanup(); expect(mocks.close).toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('refuses disabled connections, empty permissions and missing keys', async () => {
  const { event, invoke } = setup();
  mocks.get.mockReturnValue({ ...connector, enabled: false });
  expect(await invoke(event, connector.id, 'codex')).toEqual({ ok: false });
  mocks.get.mockReturnValue({ ...connector, tools: { mode: 'listed', allowed: [] } });
  expect(await invoke(event, connector.id, 'codex')).toEqual({ ok: false });
  mocks.get.mockReturnValue(connector); mocks.values.mockReturnValue({ ok: false });
  expect(await invoke(event, connector.id, 'codex')).toEqual({ ok: false });
  expect(mocks.gateway).not.toHaveBeenCalled();
});
