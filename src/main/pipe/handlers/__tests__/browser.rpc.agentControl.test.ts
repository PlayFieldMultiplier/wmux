import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { dispatchAsClaimedCaller } from './claimedCaller';
import { BrowserAgentControl } from '../../../browser-session/BrowserAgentControl';

const mockWebContents = {
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  getURL: vi.fn(() => 'https://example.com'),
  debugger: { sendCommand: vi.fn(async () => ({ result: { value: 2 } })), isAttached: vi.fn(() => true) },
};

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => mockWebContents) },
}));
vi.mock('../../../security/navigationPolicy', () => ({
  validateResolvedNavigationUrl: vi.fn(async () => ({ valid: true })),
}));
vi.mock('../_bridge', () => ({
  sendToRenderer: vi.fn(async () => ({ ok: true })),
}));

const SURFACE = {
  surfaceId: 'tab-1', webContentsId: 42,
  targetId: 'target-1', wsUrl: 'ws://127.0.0.1/devtools/page/1', workspaceId: 'ws-a',
};

function setup() {
  const revoked = new Map<string, Error>();
  const cdp = {
    getTarget: vi.fn((surfaceId?: string) => (!surfaceId || surfaceId === SURFACE.surfaceId ? SURFACE : null)),
    waitForTarget: vi.fn(async () => SURFACE),
    ensureAwake: vi.fn(async () => null),
    listTargets: vi.fn(() => [SURFACE]),
    getCdpPort: vi.fn(() => 18800),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn((sid: string) => `lease-for-${sid}`),
    renewRpcLease: vi.fn((token: string) => !revoked.has(token)),
    releaseRpcLease: vi.fn(() => true),
    rpcLeaseRevocation: vi.fn((token: string) => revoked.get(token)),
    watchRpcLease: vi.fn(async () => undefined),
  };
  const control = new BrowserAgentControl({
    emit: () => undefined,
    cancelInFlight: (_surfaceId, error) => revoked.set('lease-held', error),
  });
  const router = dispatchAsClaimedCaller(new RpcRouter());
  registerBrowserRpc(
    router,
    () => null as unknown as BrowserWindow,
    cdp as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    control,
  );
  return { router, cdp, control };
}

const acquire = (router: RpcRouter, authorize: boolean) =>
  router.dispatch({
    id: 'a',
    method: 'browser.lease.acquire',
    params: { surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a', ...(authorize && { authorize: true }) },
  });

describe('browser RPC — the user paused or took over the tab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses the MCP lane\'s lease while paused, with the stable code, and leases again after Resume', async () => {
    const { router, cdp, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');

    for (const authorize of [true, false]) {
      const res = await acquire(router, authorize);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('BROWSER_AGENT_PAUSED: the user paused agent control of this tab');
    }
    expect(cdp.acquireRpcLease).not.toHaveBeenCalled();

    control.apply(SURFACE.surfaceId, 'resume');
    const res = await acquire(router, true);
    expect(res.ok).toBe(true);
    expect(cdp.acquireRpcLease).toHaveBeenCalledWith(SURFACE.surfaceId);
  });

  it('refuses main\'s own leased browser calls while the user has the tab, before the page is touched', async () => {
    const { router, cdp, control } = setup();
    control.apply(SURFACE.surfaceId, 'takeOver');

    const res = await router.dispatch({
      id: 'e',
      method: 'browser.evaluate',
      params: { expression: '1+1', surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_USER_IN_CONTROL');
    expect(cdp.withAutomationLease).not.toHaveBeenCalled();
    expect(mockWebContents.debugger.sendCommand).not.toHaveBeenCalled();

    control.apply(SURFACE.surfaceId, 'handBack');
    const after = await router.dispatch({
      id: 'e2',
      method: 'browser.evaluate',
      params: { expression: '1+1', surfaceId: SURFACE.surfaceId, workspaceId: 'ws-a' },
    });
    expect(after.ok).toBe(true);
  });

  it('a renew of a lease the user ended fails with the reason, so the op in flight stops', async () => {
    const { router, control } = setup();
    control.apply(SURFACE.surfaceId, 'stop');

    const res = await router.dispatch({ id: 'r', method: 'browser.lease.renew', params: { token: 'lease-held' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/BROWSER_AGENT_PAUSED: the user stopped this action/);
  });

  it('a renew with waitMs parks on the lease and says it did', async () => {
    const { router, cdp } = setup();
    const res = await router.dispatch({ id: 'w', method: 'browser.lease.renew', params: { token: 'lease-x', waitMs: 60_000 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ ok: true, watched: true });
    // Capped well inside the lease TTL.
    expect(cdp.watchRpcLease).toHaveBeenCalledWith('lease-x', 8_000);

    const plain = await router.dispatch({ id: 'p', method: 'browser.lease.renew', params: { token: 'lease-x' } });
    if (plain.ok) expect(plain.result).toEqual({ ok: true });
  });
});
