import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { BrowserBackendStore } from '../../../browser-session/BrowserBackendStore';
import { ALLOW_PRIVATE_NETWORK_ENV, validateNavigationUrl } from '../../../../shared/types';
import { dispatchAsClaimedCaller } from './claimedCaller';

/**
 * Settings → Browser → Allow private network addresses, end to end in main:
 * the real store, the real navigation policy (not mocked here), the real RPC
 * handlers. A toggle must change the very next navigation with no restart, and
 * the MCP server's preflight — which asks main for the switch — must reach the
 * same verdict main does for the same URL (#1359).
 */

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

// The MCP server's RPC client, wired straight into this main's router: the
// preflight's read travels the same handler a real pipe would reach.
const mcpTransport = vi.hoisted(() => ({
  send: (_method: string, _params?: Record<string, unknown>): Promise<unknown> =>
    Promise.reject(new Error('wmux is not running. Start the app first.')),
}));
vi.mock('../../../../mcp/wmux-client', () => ({
  sendRpc: (method: string, params?: Record<string, unknown>) => mcpTransport.send(method, params),
}));

import { readNavigationPolicy } from '../../../../mcp/playwright/navigationPolicy';

const PRIVATE_URLS = ['http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://[fd00::1]/'];
const NEVER_URLS = [
  'http://169.254.169.254/',
  'http://[fe80::1]/',
  'http://0.0.0.0/',
  'http://[::]/',
  'http://127.0.0.2/',
  'http://[::ffff:169.254.169.254]/',
];

let dir: string;
let store: BrowserBackendStore;
let router: RpcRouter;

async function dispatch(method: string, params: Record<string, unknown> = {}) {
  const response = await router.dispatch({ id: '1', method, params } as never);
  return response.ok
    ? { result: (response as { result?: unknown }).result }
    : { error: String((response as { error?: unknown }).error ?? '') };
}

/** main's verdict: browser.open validates the URL, then hands it to the renderer. */
async function mainAllows(url: string): Promise<boolean> {
  sendToRendererMock.mockClear();
  const res = await dispatch('browser.open', { url, workspaceId: 'ws-1' });
  return res.error === undefined && sendToRendererMock.mock.calls.length === 1;
}

/** The MCP preflight's verdict: the switch from main, then the shared policy. */
async function mcpAllows(url: string): Promise<boolean> {
  return validateNavigationUrl(url, await readNavigationPolicy()).valid;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  sendToRendererMock.mockResolvedValue({ ok: true });
  dir = mkdtempSync(join(tmpdir(), 'wmux-private-network-'));
  store = new BrowserBackendStore(dir);
  router = dispatchAsClaimedCaller(new RpcRouter());
  // No builtin surface: browser.open goes to the renderer, which is mocked.
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    isDiscarded: vi.fn(() => false),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(router, () => null as unknown as BrowserWindow, cdp as never, store);
  mcpTransport.send = async (method, params) => {
    const res = await dispatch(method, params ?? {});
    if (res.error !== undefined) throw new Error(res.error);
    return res.result;
  };
});

afterEach(() => {
  delete process.env[ALLOW_PRIVATE_NETWORK_ENV];
  rmSync(dir, { recursive: true, force: true });
});

describe('private-network setting in main', () => {
  it('answers browser.navigationPolicy.get from the store, live', async () => {
    await expect(dispatch('browser.navigationPolicy.get')).resolves.toEqual({
      result: { allowPrivateNetwork: false },
    });
    store.setAllowPrivateNetwork(true);
    await expect(dispatch('browser.navigationPolicy.get')).resolves.toEqual({
      result: { allowPrivateNetwork: true },
    });
  });

  it('reports main\'s environment variable as on too (setting OR env)', async () => {
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    await expect(dispatch('browser.navigationPolicy.get')).resolves.toEqual({
      result: { allowPrivateNetwork: true },
    });
  });

  it.each(PRIVATE_URLS)('a toggle changes the very next navigation to %s, with no restart', async (url) => {
    const off = await dispatch('browser.open', { url, workspaceId: 'ws-1' });
    expect(off.error).toContain('turn on Settings → Browser → Allow private network addresses');
    expect(sendToRendererMock).not.toHaveBeenCalled();

    store.setAllowPrivateNetwork(true);
    expect(await mainAllows(url)).toBe(true);

    store.setAllowPrivateNetwork(false);
    expect(await mainAllows(url)).toBe(false);
  });

  it.each(NEVER_URLS)('never lets %s through, with the setting on', async (url) => {
    store.setAllowPrivateNetwork(true);
    expect(await mainAllows(url)).toBe(false);
  });

  it('lets the environment variable alone open the private ranges', async () => {
    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    expect(await mainAllows('http://10.0.0.1/')).toBe(true);
  });
});

describe('the MCP preflight agrees with main', () => {
  // Address literals only: a hostname would send main to real DNS.
  it.each([...PRIVATE_URLS, ...NEVER_URLS, 'http://8.8.8.8/'])(
    '%s gets one verdict from both, before and after a toggle',
    async (url) => {
      for (const on of [false, true, false]) {
        store.setAllowPrivateNetwork(on);
        expect(await mcpAllows(url), `mcp, setting ${on}`).toBe(await mainAllows(url));
      }
    },
  );

  it('falls back to the environment variable alone when main cannot answer', async () => {
    mcpTransport.send = () => Promise.reject(new Error('wmux is not running. Start the app first.'));
    store.setAllowPrivateNetwork(true);
    // The setting is on, but the preflight cannot know: it refuses.
    expect(await mcpAllows('http://10.0.0.1/')).toBe(false);

    process.env[ALLOW_PRIVATE_NETWORK_ENV] = '1';
    expect(await mcpAllows('http://10.0.0.1/')).toBe(true);
    // ...and still never the metadata address.
    expect(await mcpAllows('http://169.254.169.254/')).toBe(false);
  });
});
