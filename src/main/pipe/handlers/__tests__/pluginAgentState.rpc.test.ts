import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerPaneRpc } from '../pane.rpc';
import type { PluginIdentityRecord } from '../../../../shared/rpc';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: read }));
const snapshot = { workspaceId: 'w1', panes: [], truncated: false };
function setup(caps = ['agent.state.read'], status: PluginIdentityRecord['status'] = 'trusted') {
  const router = new RpcRouter();
  const trust: PluginIdentityRecord = { name: 'demo', firstSeen: 1, lastSeen: 1, status, declaredCapabilities: caps };
  router.setTrustLookup(async () => trust);
  registerPaneRpc(router, () => null);
  const call = (params: Record<string, unknown> = {}, hostedWorkspace: string | null = 'w1') => router.dispatch({ id: 'r', method: 'agent.state', clientName: 'demo', params }, { firstParty: true, hostedWorkspace });
  return { router, trust, call };
}
beforeEach(() => { read.mockReset(); read.mockResolvedValue(snapshot); });
describe('agent.state permission and scope boundary', () => {
  it('substitutes the host workspace and strips undeclared response fields', async () => {
    const { call } = setup();
    read.mockResolvedValue({ ...snapshot, privateText: 'secret' });
    expect(await call({ workspaceId: 'other' })).toMatchObject({ ok: true, result: snapshot });
    expect(read).toHaveBeenCalledWith(expect.any(Function), 'agent.state', { workspaceId: 'w1', includeActivity: false });
  });
  it.each(['unconfirmed', 'denied'] as const)('refuses %s even in shadow mode', async (status) => {
    const { call } = setup(['agent.state.read'], status);
    expect(await call()).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('refuses a scoped base-state grant with no supported path namespace', async () => {
    expect(await setup(['agent.state.read:never.matches']).call()).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('requires both state and terminal permissions for activity', async () => {
    expect(await setup().call({ includeActivity: true })).toMatchObject({ ok: false });
    expect(await setup(['terminal.read']).call({ includeActivity: true })).toMatchObject({ ok: false });
    expect(await setup(['agent.state.read', 'terminal.read:never.matches']).call({ includeActivity: true })).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
    expect(await setup(['terminal.read', 'agent.state.read']).call({ includeActivity: true })).toMatchObject({ ok: true });
  });
  it('refuses unbound hosts, external callers, and mismatched response scopes', async () => {
    const { call, router } = setup();
    expect(await call({}, null)).toMatchObject({ ok: false });
    expect(await router.dispatch({ id: 'x', method: 'agent.state', clientName: 'demo', params: { workspaceId: 'w1' } })).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValue({ ...snapshot, workspaceId: 'other' });
    expect(await call()).toMatchObject({ ok: false });
  });
  it('rechecks trust after the renderer answers', async () => {
    const { call, trust } = setup();
    read.mockImplementation(async () => { trust.status = 'denied'; return snapshot; });
    expect(await call()).toMatchObject({ ok: false });
  });
});
