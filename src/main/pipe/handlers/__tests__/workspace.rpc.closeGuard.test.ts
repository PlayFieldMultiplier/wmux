// workspace.close refuses the caller's own workspace unless `force` is set.
// An orchestrating agent read a fan-out accept's owner workspace id as a
// task's and closed the workspace it was running in, with every agent inside.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerWorkspaceRpc } from '../workspace.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const owners: Record<string, string> = { 'daemon-own': 'ws-own' };

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerWorkspaceRpc(router, () => fakeWindow, {
    resolveCallerWorkspace: async (pty) => owners[pty] ?? null,
  });
  return router;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendToRendererMock.mockResolvedValue({ ok: true });
});

describe('workspace.close — the caller’s own workspace', () => {
  it('is refused without force, before reaching the renderer', async () => {
    const res = await setup().dispatch({ id: 'c1', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-own' } });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/workspace this call comes from/);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('goes through with force, and force reaches the renderer', async () => {
    const res = await setup().dispatch({ id: 'c3', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-own', force: true } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'workspace.close', { id: 'ws-own', force: true });
  });

  it('another workspace closes as before; an unresolvable pty skips the check', async () => {
    let res = await setup().dispatch({ id: 'c4', method: 'workspace.close', params: { id: 'ws-other', senderPtyId: 'daemon-own' } });
    expect(res.ok).toBe(true);
    res = await setup().dispatch({ id: 'c5', method: 'workspace.close', params: { id: 'ws-own', senderPtyId: 'daemon-gone' } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenLastCalledWith(expect.anything(), 'workspace.close', { id: 'ws-own' });
  });

  it('an earlier version\'s HQ workspace closes like any other', async () => {
    const res = await setup().dispatch({ id: 'c6', method: 'workspace.close', params: { id: 'ws-hq' } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenLastCalledWith(expect.anything(), 'workspace.close', { id: 'ws-hq' });
  });
});

describe('workspace.close — a browser tab the user holds', () => {
  function setupHeld(held: string[]): RpcRouter {
    const router = new RpcRouter();
    registerWorkspaceRpc(router, () => fakeWindow, {
      resolveCallerWorkspace: async () => null,
      agentControl: {
        list: () => held.map((surfaceId) => ({ surfaceId, active: false, mode: 'user' as const })),
        refusal: (surfaceId: string, method: string) =>
          held.includes(surfaceId) ? new Error(`${method}: BROWSER_USER_IN_CONTROL: the user took over this tab`) : null,
      },
    });
    return router;
  }

  it('is refused, force or not, when the workspace holds a tab the user took over', async () => {
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      method === 'surface.list' ? [{ id: 'tab-1', paneId: 'p1', surfaceType: 'browser' }] : { ok: true });
    for (const force of [false, true]) {
      const res = await setupHeld(['tab-1']).dispatch({ id: `h-${force}`, method: 'workspace.close', params: { id: 'ws-x', force } });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('workspace.close: BROWSER_USER_IN_CONTROL');
    }
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.anything(), 'surface.list', { workspaceId: 'ws-x', includeStashed: true });
    expect(sendToRendererMock).not.toHaveBeenCalledWith(expect.anything(), 'workspace.close', expect.anything());
  });

  it('closes when the held tab is in another workspace', async () => {
    sendToRendererMock.mockImplementation(async (_w: unknown, method: string) =>
      method === 'surface.list' ? [{ id: 'tab-9', paneId: 'p1', surfaceType: 'browser' }] : { ok: true });
    const res = await setupHeld(['tab-1']).dispatch({ id: 'h2', method: 'workspace.close', params: { id: 'ws-x' } });
    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenLastCalledWith(expect.anything(), 'workspace.close', { id: 'ws-x' });
  });
});
