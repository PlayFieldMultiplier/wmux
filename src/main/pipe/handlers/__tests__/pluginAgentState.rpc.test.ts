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
    expect(read).toHaveBeenCalledWith(expect.any(Function), 'agent.state', { workspaceId: 'w1', includeActivity: false }, { timeoutError: expect.any(Error) });
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
  it('preserves retryable startup failures but not malformed responses', async () => {
    const { call } = setup();
    read.mockResolvedValue({ error: 'wmux is still starting (paneGate=pending)', retryable: true });
    expect(await call()).toMatchObject({ ok: false, error: 'wmux is still starting (paneGate=pending)', retryable: true });
    read.mockResolvedValue({ error: 'Invalid scope', retryable: false });
    expect(await call()).toMatchObject({ ok: false, error: 'Invalid scope' });
    expect(await call()).not.toHaveProperty('retryable');
    read.mockResolvedValue({ retryable: true });
    expect(await call()).not.toHaveProperty('retryable');
  });
  it('rechecks trust after the renderer answers', async () => {
    const { call, trust } = setup();
    read.mockImplementation(async () => { trust.status = 'denied'; return snapshot; });
    expect(await call()).toMatchObject({ ok: false });
  });
  it('marks a missing renderer responder as retryable and accepts a later response', async () => {
    const { call } = setup();
    read.mockImplementationOnce(async (_window, _method, _params, options) => { throw options.timeoutError; });
    expect(await call()).toMatchObject({ ok: false, retryable: true, error: 'Agent state responder is not ready; retry the request' });
    expect(await call()).toMatchObject({ ok: true, result: snapshot });
  });
});

const all = {
  truncated: false,
  workspaces: [
    { workspaceId: 'w1', name: 'alpha', truncated: false, panes: [] },
    { workspaceId: 'w2', name: 'beta', truncated: false, panes: [{ paneId: 'p2', label: 'api', state: 'needsYou', stashed: false, surfaces: [{ surfaceId: 's2', agentName: 'Codex' }] }] },
  ],
};

describe('agent.state.all: a separate grant for every workspace', () => {
  const callAll = (router: RpcRouter, params: Record<string, unknown> = {}, hostedWorkspace: string | null = 'w1') =>
    router.dispatch({ id: 'a', method: 'agent.state.all', clientName: 'demo', params }, { firstParty: true, hostedWorkspace });

  it('gives a plugin without the grant one workspace, and one with it every workspace', async () => {
    const without = setup(['agent.state.read']);
    expect(await callAll(without.router)).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
    // The single-workspace read is exactly today's, grant or not.
    expect(await without.call({ workspaceId: 'w2' })).toMatchObject({ ok: true, result: snapshot });
    expect(read).toHaveBeenLastCalledWith(expect.any(Function), 'agent.state', { workspaceId: 'w1', includeActivity: false }, { timeoutError: expect.any(Error) });

    read.mockReset();
    read.mockResolvedValue({ ...all, private: 'x' });
    const granted = setup(['agent.state.read', 'agent.state.read.all']);
    expect(await callAll(granted.router)).toMatchObject({ ok: true, result: all });
    expect(read).toHaveBeenCalledWith(expect.any(Function), 'agent.state.all', {}, { timeoutError: expect.any(Error) });
  });

  it.each(['unconfirmed', 'denied'] as const)('refuses a %s plugin even in shadow mode', async (status) => {
    expect(await callAll(setup(['agent.state.read.all'], status).router)).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a scoped grant, unbound hosts, external callers and activity', async () => {
    expect(await callAll(setup(['agent.state.read.all:w1']).router)).toMatchObject({ ok: false });
    const { router } = setup(['agent.state.read.all', 'terminal.read']);
    expect(await callAll(router, {}, null)).toMatchObject({ ok: false });
    expect(await router.dispatch({ id: 'x', method: 'agent.state.all', clientName: 'demo', params: {} })).toMatchObject({ ok: false });
    expect(await callAll(router, { includeActivity: true })).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('checks the grant again after the renderer answers, on every read', async () => {
    const { router, trust } = setup(['agent.state.read', 'agent.state.read.all']);
    read.mockResolvedValue(all);
    expect(await callAll(router)).toMatchObject({ ok: true });
    // Revoked while a read is in flight: that answer is not delivered.
    read.mockImplementation(async () => { trust.declaredCapabilities = ['agent.state.read']; return all; });
    expect(await callAll(router)).toMatchObject({ ok: false, error: 'Agent state permission changed' });
    // And the next read is refused before the renderer is asked.
    read.mockClear();
    expect(await callAll(router)).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('answers each read from the renderer, so a workspace created or closed since is in or out', async () => {
    const { router } = setup(['agent.state.read.all']);
    read.mockResolvedValueOnce(all).mockResolvedValueOnce({ ...all, workspaces: [all.workspaces[1]] });
    expect(((await callAll(router)) as { result: typeof all }).result.workspaces.map((w) => w.workspaceId)).toEqual(['w1', 'w2']);
    expect(((await callAll(router)) as { result: typeof all }).result.workspaces.map((w) => w.workspaceId)).toEqual(['w2']);
  });
});

describe('pane.focus from a plugin granted every workspace', () => {
  const focus = (router: RpcRouter, params: Record<string, unknown>, hostedWorkspace: string | null = 'w1') =>
    router.dispatch({ id: 'f', method: 'pane.focus', clientName: 'demo', params }, { firstParty: true, hostedWorkspace });
  beforeEach(() => { read.mockResolvedValue({ ok: true }); });

  it('stays confined to the bound workspace without the grant', async () => {
    await focus(setup(['agent.state.read', 'pane.read']).router, { id: 'p2' });
    expect(read).toHaveBeenCalledWith(expect.any(Function), 'pane.focus', { id: 'p2', confineWorkspaceId: 'w1' });
  });

  it('may take the user to another workspace with the grant', async () => {
    await focus(setup(['agent.state.read', 'agent.state.read.all', 'pane.read']).router, { id: 'p2' });
    expect(read).toHaveBeenCalledWith(expect.any(Function), 'pane.focus', { id: 'p2', revealWorkspace: true });
  });

  it('never takes the flag from the plugin, and never widens an unapproved or unbound plugin', async () => {
    await focus(setup(['agent.state.read', 'pane.read']).router, { id: 'p2', revealWorkspace: true });
    expect(read).toHaveBeenLastCalledWith(expect.any(Function), 'pane.focus', { id: 'p2', confineWorkspaceId: 'w1' });
    await focus(setup(['agent.state.read.all', 'pane.read'], 'unconfirmed').router, { id: 'p2' });
    expect(read).not.toHaveBeenCalledWith(expect.any(Function), 'pane.focus', expect.objectContaining({ revealWorkspace: true }));
    read.mockClear();
    expect(await focus(setup(['agent.state.read.all', 'pane.read']).router, { id: 'p2' }, null)).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps close, stash and unstash confined with the grant', async () => {
    const { router } = setup(['agent.state.read.all', 'pane.read', 'pane.create', 'pane.write']);
    for (const method of ['pane.close', 'pane.stash', 'pane.unstash'] as const) {
      await router.dispatch({ id: method, method, clientName: 'demo', params: { id: 'p2' } }, { firstParty: true, hostedWorkspace: 'w1' });
      expect(read).toHaveBeenLastCalledWith(expect.any(Function), method, { id: 'p2', confineWorkspaceId: 'w1' });
    }
  });
});
