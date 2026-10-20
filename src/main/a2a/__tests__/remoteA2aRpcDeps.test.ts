import { describe, expect, it, vi } from 'vitest';
import { daemonRemoteA2aRpcDeps } from '../remoteA2aRpcDeps';

const none = Promise.resolve((): number => 0);
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('daemonRemoteA2aRpcDeps', () => {
  it('maps each hook to its daemon RPC', async () => {
    const rpc = vi.fn(async (method: string) => (method === 'a2a.remote.targets' ? { targets: [{ alias: 'a/b/c' }] } : { ok: true, taskId: 'rt-x' }));
    const deps = daemonRemoteA2aRpcDeps(() => ({ rpc }));
    expect(await deps.listTargets()).toEqual([{ alias: 'a/b/c' }]);
    expect(await deps.reply({ taskId: 'rt-x', workspaceId: 'ws', text: 't' })).toEqual({ ok: true, taskId: 'rt-x' });
    expect(rpc).toHaveBeenLastCalledWith('a2a.remote.reply', { taskId: 'rt-x', workspaceId: 'ws', text: 't' });
  });

  it('without a daemon: no targets, every op unavailable; a refusal keeps its code', async () => {
    const none = daemonRemoteA2aRpcDeps(() => null);
    expect(await none.listTargets()).toEqual([]);
    expect(await none.state({ taskId: 'rt-x', state: 'working' })).toEqual({ ok: false, error: 'unavailable' });
    const refusing = daemonRemoteA2aRpcDeps(() => ({ rpc: async () => ({ ok: false, error: 'link-not-active' }) }));
    expect(await refusing.sendTask({ linkId: 'l', from: { workspaceId: 'w', name: 'w', paneId: 'p' }, title: '', text: 't' }))
      .toEqual({ ok: false, error: 'link-not-active' });
  });

  it('listPeers: paired PCs without an active link, as counts and a hint, never a pane name or id', async () => {
    const JOINED = 'host-joined';
    const SERVED = 'host-served';
    const LINKED = 'host-linked';
    const link = (hostId: string, state: string, workspaceId = 'ws-a') => ({
      linkId: `l-${hostId}-${state}`, state, local: { kind: 'pane', workspaceId, paneId: 'p-local' },
      remote: { hostId, kind: 'pane', workspaceId: 'ws-remote', paneId: 'p-remote', label: 'remote-label' },
    });
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'a2a.remote.hosts.status') {
        return { hosts: [
          { hostId: JOINED, name: 'mac-mini', role: 'joiner', state: 'connected', pending: 0, lastError: '10.0.0.9 refused' },
          { hostId: SERVED, name: 'desk', role: 'server', state: 'connected', pending: 0 },
          { hostId: LINKED, name: 'laptop', role: 'joiner', state: 'connected', pending: 0 },
        ] };
      }
      if (method === 'a2a.remote.links.list') {
        return { links: [link(LINKED, 'active'), link(SERVED, 'proposed-in'), link(JOINED, 'active', 'ws-other')] };
      }
      if (method === 'a2a.remote.hosts.exposed') {
        // What the other PC chose to show; its unshown panes never reach this PC.
        return params.hostId === JOINED
          ? { ok: true, panes: [
            { kind: 'pane', workspaceId: 'ws-shown', workspaceName: 'shown-ws', paneId: 'p-shown', label: 'shown-label', cwd: '/srv/app' },
            { kind: 'brain', workspaceId: 'ws-hq', workspaceName: 'HQ' },
          ] }
          : { ok: true, panes: [] };
      }
      if (method === 'a2a.remote.exposure.get') {
        return { exposure: { v: 1, hostId: SERVED, workspaceIds: ['ws-a'], paneIds: { 'ws-a': ['p-mine'] }, updatedAt: 'x' } };
      }
      return {};
    });
    const deps = daemonRemoteA2aRpcDeps(() => ({ rpc }));
    // The first call never waits on the other PC: its count is unknown until the background read lands.
    expect((await deps.listPeers!('ws-a', none))[0]).toMatchObject({ name: 'mac-mini', exposedPanes: null });
    await flush();
    const peers = await deps.listPeers!('ws-a', none);
    expect(peers).toEqual([
      { name: 'mac-mini', paired: true, connected: true, exposedPanes: 1, pendingLinks: 0, hint: expect.stringMatching(/shows 1 pane, none linked/) },
      { name: 'desk', paired: true, connected: true, exposedPanes: null, pendingLinks: 1, hint: expect.stringMatching(/link request from that PC/) },
    ]);
    const text = JSON.stringify(peers);
    for (const secret of [JOINED, SERVED, 'p-shown', 'shown-label', 'shown-ws', 'ws-shown', '/srv/app', 'p-mine', 'p-remote', 'remote-label', '10.0.0.9']) {
      expect(text).not.toContain(secret);
    }
    // Only the PC this one joined is asked what it shows, once per TTL.
    expect(rpc.mock.calls.filter((c) => c[0] === 'a2a.remote.hosts.exposed').map((c) => c[1])).toEqual([{ hostId: JOINED }]);
  });

  it('listPeers: a paired PC that shows nothing says so; no daemon lists nothing', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'a2a.remote.hosts.status') return { hosts: [{ hostId: 'h', name: 'mac-mini', role: 'joiner', state: 'connected', pending: 0 }] };
      if (method === 'a2a.remote.links.list') return { links: [] };
      if (method === 'a2a.remote.hosts.exposed') return { ok: true, panes: [] };
      return {};
    });
    const deps = daemonRemoteA2aRpcDeps(() => ({ rpc }));
    await deps.listPeers!(undefined, none);
    await flush();
    expect(await deps.listPeers!(undefined, none)).toEqual([
      { name: 'mac-mini', paired: true, connected: true, exposedPanes: 0, pendingLinks: 0, hint: expect.stringMatching(/shows no pane to this one/) },
    ]);
    expect(await daemonRemoteA2aRpcDeps(() => null).listPeers!(undefined, none)).toEqual([]);
    // A PC that joined this one and sees a whole workspace (no pane list): that workspace's panes now.
    const whole = vi.fn(async (method: string) => {
      if (method === 'a2a.remote.hosts.status') return { hosts: [{ hostId: 'h', name: 'desk', role: 'server', state: 'connected', pending: 0 }] };
      if (method === 'a2a.remote.links.list') return { links: [] };
      if (method === 'a2a.remote.exposure.get') return { exposure: { v: 1, hostId: 'h', workspaceIds: ['ws'], updatedAt: 'x' } };
      return {};
    });
    const [desk] = await daemonRemoteA2aRpcDeps(() => ({ rpc: whole })).listPeers!(undefined, Promise.resolve((ws: string) => (ws === 'ws' ? 3 : 0)));
    expect(desk.hint).toMatch(/this PC shows it at least 3 panes, none linked/);
    // Discover counts terminal panes only: a whole workspace it sees as empty is unknown, never "no pane".
    const [blank] = await daemonRemoteA2aRpcDeps(() => ({ rpc: whole })).listPeers!(undefined, none);
    expect(blank.hint).not.toMatch(/no pane yet/);
  });
});
