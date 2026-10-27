import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';

// On a dedicated Chrome profile a help request may name only a tab its own
// workspace opened, the same rule the builtin backend applies to panes.

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => false;
    on(): this {
      return this;
    }
    show(): void {
      /* not shown: isSupported is false */
    }
  }
  return { Notification, webContents: { fromId: vi.fn(() => null) } };
});
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn(async () => ({ ok: true })) }));

// A dedicated instance: no writeScope. listTargets lets an unattributed record
// through, so cdpInfoTargets (which forwards to it) does too.
const TABS = [
  { surfaceId: 'mine', targetId: 't-mine', workspaceId: 'ws-1', url: 'https://a.test/', title: 'A' },
  { surfaceId: 'theirs', targetId: 't-theirs', workspaceId: 'ws-2', url: 'https://b.test/', title: 'B' },
  { surfaceId: 'orphan', targetId: 't-orphan', url: 'https://c.test/', title: 'C' },
];

function register(options: { live?: boolean } = {}) {
  const router = dispatchAsClaimedCaller(new RpcRouter());
  const cdp = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  const client = {
    // Live Chrome is the client with a writeScope; a user tab is never listed.
    ...(options.live && { writeScope: { ownerOf: vi.fn(() => 'user') } }),
    endpoint: vi.fn(async () => ({ cdpPort: 9333 })),
    cdpInfoTargets: vi.fn(async (workspaceId?: string) =>
      options.live ? [] : TABS.filter((t) => workspaceId === undefined || t.workspaceId === undefined || t.workspaceId === workspaceId),
    ),
    listTargets: vi.fn(async () => TABS),
    openTab: vi.fn(),
    closeSurface: vi.fn(async () => true),
    hasSurface: vi.fn(() => true),
    dispose: vi.fn(),
  };
  const registry = {
    profileFor: vi.fn(() => 'pane-prof'),
    hasPaneBindings: vi.fn(() => false),
    isPaneBound: vi.fn(() => false),
    forProfile: vi.fn(() => client),
    ownerOfSurface: vi.fn(() => null),
    disposeAll: vi.fn(),
  };
  const help = registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    { get: () => 'chrome' } as never,
    undefined,
    undefined,
    registry as never,
  );
  return { router, registry, help };
}

async function request({ router }: { router: RpcRouter }, surfaceId: string) {
  return router.dispatch({
    id: '1',
    method: 'browser.help.request',
    params: { workspaceId: 'ws-1', surfaceId, prompt: 'Solve the captcha' },
  } as never);
}

describe('browser.help.request on a dedicated Chrome profile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['theirs', 'orphan', 't-theirs'])('refuses a tab this workspace did not open (%s)', async (surfaceId) => {
    const response = await request(register(), surfaceId);
    expect(response.ok).toBe(false);
    expect(String((response as { error?: unknown }).error)).toContain('BROWSER_SURFACE_NOT_REGISTERED');
  });

  it('accepts a tab this workspace opened, resolving its Chrome once', async () => {
    const { router, registry } = register();
    const response = await request({ router }, 'mine');
    expect(response.ok).toBe(true);
    expect(registry.forProfile).toHaveBeenCalledTimes(1);
    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } } as never);
  });

  it('pins the tab\'s origin on the request when it is made', async () => {
    const { router, help } = register();
    const response = await request({ router }, 'mine');
    expect(response.ok).toBe(true);
    expect(help.listPending().map((r) => r.origin)).toEqual(['https://a.test']);
    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } } as never);
  });

  it('on Live Chrome, the origin is unknown', async () => {
    const { router, help } = register({ live: true });
    const response = await request({ router }, 'user-tab');
    expect(response.ok).toBe(true);
    expect(help.listPending().map((r) => r.origin)).toEqual([undefined]);
    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } } as never);
  });

  it('accepts its own tab named by the raw CDP targetId', async () => {
    const { router } = register();
    const response = await request({ router }, 't-mine');
    expect(response.ok).toBe(true);
    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } } as never);
  });

  it('on Live Chrome, still accepts a tab the workspace did not open', async () => {
    const { router } = register({ live: true });
    const response = await request({ router }, 'user-tab');
    expect(response.ok).toBe(true);
    const requestId = (response as { result?: { requestId?: string } }).result?.requestId;
    await router.dispatch({ id: '2', method: 'browser.help.cancel', params: { workspaceId: 'ws-1', requestId } } as never);
  });
});
