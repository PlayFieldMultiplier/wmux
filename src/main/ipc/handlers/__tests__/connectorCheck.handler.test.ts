import type { ConnectorOAuth } from '../../../connectors/connectorOAuth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { Connector } from '../../../../shared/botConnector';
import type { ConnectorCheckResult } from '../../../../shared/connectorCheck';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), remove: vi.fn(), get: vi.fn(), values: vi.fn(), check: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.remove } }));
vi.mock('../../../factory/connectorStore', () => ({ getConnectorStore: () => ({ get: mocks.get }) }));
vi.mock('../../../factory/secretStore', () => ({ getSecretStore: () => ({ values: mocks.values }) }));
vi.mock('../../../connectors/checkConnector', () => ({ checkConnector: mocks.check }));
import { registerConnectorCheckHandlers } from '../connectorCheck.handler';
const connector: Connector = { id: 'con-00000001', name: 'example', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} }, secrets: [{ secret: 'TEST_KEY', as: 'header', header: 'Authorization', scheme: 'bearer' }], tools: { mode: 'all', blocked: [] }, scope: { kind: 'all' }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1 };
let cleanup: () => void;
function setup(oauth?: ConnectorOAuth) {
  const frame = {};
  const contents = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  mocks.get.mockReturnValue(connector);
  mocks.values.mockReturnValue({ ok: true, env: { TEST_KEY: 'local-test-only' } });
  mocks.check.mockResolvedValue({ status: 'ready', toolCount: 1, checkedAt: 1 });
  cleanup = registerConnectorCheckHandlers(() => win, oauth);
  const invoke = mocks.handle.mock.calls.at(-1)?.[1] as (event: unknown, id: unknown) => Promise<ConnectorCheckResult>;
  return { invoke, event: { sender: contents, senderFrame: frame } };
}
afterEach(() => { cleanup?.(); vi.resetAllMocks(); });
describe('connector check IPC boundary', () => {
  it('refuses foreign windows and subframes before reading credentials', async () => {
    const { invoke, event } = setup();
    expect(await invoke({ ...event, senderFrame: {} }, connector.id)).toEqual({ status: 'unavailable' });
    expect(await invoke({ ...event, sender: {} }, connector.id)).toEqual({ status: 'unavailable' });
    expect(mocks.values).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
  });
  it('resolves credentials main-side and never returns them', async () => {
    const { invoke, event } = setup();
    const r = await invoke(event, connector.id);
    expect(mocks.check.mock.calls[0][1]).toEqual({ Authorization: 'Bearer local-test-only' });
    expect(JSON.stringify(r)).not.toContain('local-test-only');
  });
  it('refuses missing keys without contacting the server', async () => {
    const { invoke, event } = setup(); mocks.values.mockReturnValue({ ok: false, missing: ['TEST_KEY'] });
    expect(await invoke(event, connector.id)).toEqual({ status: 'missing-key' }); expect(mocks.check).not.toHaveBeenCalled();
  });
  it('deduplicates checks and invalidates success after configuration removal', async () => {
    const { invoke, event } = setup();
    let finish: (r: ConnectorCheckResult) => void = () => undefined;
    mocks.check.mockImplementation(() => new Promise<ConnectorCheckResult>((r) => { finish = r; }));
    const pending = invoke(event, connector.id);
    expect(await invoke(event, connector.id)).toEqual({ status: 'busy' });
    mocks.get.mockReturnValue(null); finish({ status: 'ready', toolCount: 0, checkedAt: 1 });
    expect(await pending).toEqual({ status: 'changed' });
  });
  it('invalidates a late result after credential rotation', async () => {
    const { invoke, event } = setup();
    mocks.check.mockImplementation(async () => {
      mocks.values.mockReturnValue({ ok: true, env: { TEST_KEY: 'replacement' } });
      return { status: 'ready', toolCount: 0, checkedAt: 1 };
    });
    expect(await invoke(event, connector.id)).toEqual({ status: 'changed' });
  });
  it('aborts pending network work when handlers are disposed', async () => {
    const { invoke, event } = setup();
    mocks.check.mockImplementation((_c, _h, signal: AbortSignal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'failed' }))));
    const pending = invoke(event, connector.id); cleanup();
    expect(await pending).toEqual({ status: 'changed' });
  });
});

it('does not send a resolved token after authorization is disconnected during lookup', async () => {
  let revision = 0;
  const oauth = { status: () => ({ status: 'authorized' }), revision: () => revision, accessToken: async () => { revision++; return 'revoked-token'; } } as unknown as ConnectorOAuth;
  const { invoke, event } = setup(oauth);
  expect(await invoke(event, connector.id)).toEqual({ status: 'changed' });
  expect(mocks.check).not.toHaveBeenCalled();
});
