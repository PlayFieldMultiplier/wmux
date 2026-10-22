import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerSurfaceRpc } from '../surface.rpc';
import { registerPaneRpc } from '../pane.rpc';
import { BrowserAgentControl } from '../../../browser-session/BrowserAgentControl';

const { sendToRendererMock, paneWorkspaces } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  paneWorkspaces: new Map<string, string>(),
}));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../workspace/WorkspaceMirror', () => ({
  getWorkspaceMirror: () => ({
    getPaneWorkspaces: () => paneWorkspaces,
    getEntries: () => [{ id: 'ws-a' }, { id: 'ws-b' }],
  }),
}));

const SURFACES = [
  { id: 'term-1', paneId: 'pane-1', surfaceType: 'terminal' },
  { id: 'tab-1', paneId: 'pane-1', surfaceType: 'browser' },
  { id: 'tab-2', paneId: 'pane-2', surfaceType: 'browser' },
];

function setup() {
  const control = new BrowserAgentControl({ emit: () => undefined, cancelInFlight: () => undefined });
  const router = new RpcRouter();
  const getWindow = (() => null) as () => BrowserWindow | null;
  registerSurfaceRpc(router, getWindow, control);
  registerPaneRpc(router, getWindow, { agentControl: control });
  return { router, control };
}

const closes = () => sendToRendererMock.mock.calls.filter(([, m]) => m === 'surface.close' || m === 'pane.close');

describe('surface_close / pane_close on a tab the user holds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paneWorkspaces.clear();
    paneWorkspaces.set('pane-1', 'ws-a');
    paneWorkspaces.set('pane-2', 'ws-a');
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      method === 'surface.list' ? SURFACES : { ok: true });
  });

  it('surface.close refuses a held browser tab and closes it once handed back', async () => {
    const { router, control } = setup();
    control.apply('tab-1', 'takeOver');
    const res = await router.dispatch({ id: 's', method: 'surface.close', params: { id: 'tab-1' } }, { operator: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('surface.close: BROWSER_USER_IN_CONTROL');
    expect(closes()).toEqual([]);

    control.apply('tab-1', 'handBack');
    const after = await router.dispatch({ id: 's2', method: 'surface.close', params: { id: 'tab-1' } }, { operator: true });
    expect(after.ok).toBe(true);
    expect(closes()).toHaveLength(1);
  });

  it('pane.close refuses when any browser tab in that pane is held, and only that pane', async () => {
    const { router, control } = setup();
    control.apply('tab-1', 'stop');
    const res = await router.dispatch({ id: 'p', method: 'pane.close', params: { id: 'pane-1' } }, { operator: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('pane.close: BROWSER_AGENT_PAUSED');
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'surface.list', { workspaceId: 'ws-a', includeStashed: true });

    const other = await router.dispatch({ id: 'p2', method: 'pane.close', params: { id: 'pane-2' } }, { operator: true });
    expect(other.ok).toBe(true);
    expect(closes()).toEqual([[expect.anything(), 'pane.close', { id: 'pane-2' }]]);
  });

  it('pane.close asks the renderer nothing while no tab is held', async () => {
    const { router } = setup();
    const res = await router.dispatch({ id: 'p', method: 'pane.close', params: { id: 'pane-1' } }, { operator: true });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock.mock.calls.map(([, m]) => m)).toEqual(['pane.close']);
  });

  it('pane.close searches every workspace when the pane\'s own is unknown, and refuses an unreadable answer', async () => {
    const { router, control } = setup();
    paneWorkspaces.clear();
    control.apply('tab-1', 'takeOver');
    const res = await router.dispatch({ id: 'p', method: 'pane.close', params: { id: 'pane-1' } }, { operator: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('BROWSER_USER_IN_CONTROL');

    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      method === 'surface.list' ? { error: 'renderer not ready' } : { ok: true });
    const unread = await router.dispatch({ id: 'p2', method: 'pane.close', params: { id: 'pane-2' } }, { operator: true });
    expect(unread.ok).toBe(false);
    if (!unread.ok) expect(unread.error).toContain('could not check whether this closes a browser tab');
    expect(closes()).toEqual([]);
  });
});
