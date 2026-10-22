// @vitest-environment jsdom
// The drop notice: a connection in use that stays down past its grace gets
// one toast (naming Tailscale when its tailnet address is why); a blip that
// comes back inside the grace gets none, and a recovery takes the toast away.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';
import {
  A2A_DROP_GRACE_MS,
  ConnectionDropWatch,
  SHARE_DROP_GRACE_MS,
  useConnectionDropNotice,
} from '../useConnectionDropNotice';
import type { A2aRemoteHostStatus } from '../../../shared/rpc';
import type { TailscaleChecklist } from '../../../shared/web';

const HOST = '11111111-1111-4111-8111-111111111111';
const SHARE = 'share-host-1';

describe('ConnectionDropWatch', () => {
  it('a blip inside the grace is never due; a drop past it is due once', () => {
    const w = new ConnectionDropWatch();
    const grace = () => 12_000;
    expect(w.observe('k', true, 0)).toBeNull();
    expect(w.observe('k', false, 1_000)).toBe('dropped');
    expect(w.due(12_999, grace)).toEqual([]);
    expect(w.observe('k', true, 8_000)).toBe('healed');
    expect(w.due(60_000, grace)).toEqual([]);

    expect(w.observe('k', false, 70_000)).toBe('dropped');
    expect(w.due(82_000, grace)).toEqual(['k']);
    expect(w.due(90_000, grace)).toEqual([]);
    expect(w.observe('k', true, 95_000)).toBe('recovered');
  });

  it('a connection first seen down, or with no answer either way, is not a drop', () => {
    const w = new ConnectionDropWatch();
    expect(w.observe('down-at-start', false, 0)).toBeNull();
    expect(w.due(600_000, () => 1)).toEqual([]);
    w.observe('k', true, 0);
    expect(w.observe('k', null, 1)).toBeNull();
    expect(w.due(600_000, () => 1)).toEqual([]);
  });
});

let container: HTMLDivElement;
let root: Root;
let tailscaleCheck: ReturnType<typeof vi.fn>;
let tailscaleOpen: ReturnType<typeof vi.fn>;

const OFF: TailscaleChecklist = {
  items: [
    { id: 'installed', state: 'pass' },
    { id: 'signed-in', state: 'fail', reason: 'not-running', fix: 'open-app' },
    { id: 'self', state: 'unchecked' },
    { id: 'peer', state: 'unchecked' },
  ],
  ok: false,
};

function Probe() {
  useConnectionDropNotice();
  return null;
}

function a2a(state: A2aRemoteHostStatus['state'], address = '100.101.12.4') {
  useStore.getState().setA2aRemote({
    hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state, pending: 0 }],
    links: [{ state: 'active', remote: { hostId: HOST } } as never],
    joined: [{ hostId: HOST, addresses: [address] } as never],
    loaded: true,
  });
}
function share(status: 'reachable' | 'unreachable') {
  useStore.setState({
    remoteWorkspaces: [{ key: `${SHARE}:w`, hostId: SHARE, hostLabel: 'office', workspaceId: 'w', name: 'api', panes: [] } as never],
    pcRailHostStatus: { [SHARE]: status },
  });
}
const toasts = () => useStore.getState().toasts;
async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  tailscaleCheck = vi.fn(async () => OFF);
  tailscaleOpen = vi.fn(async () => ({ ok: true, opened: 'app' }));
  vi.stubGlobal('electronAPI', {
    web: { tailscaleCheck, tailscaleOpen },
    remote: { hostsList: vi.fn(async () => [{ id: SHARE, label: 'office', origin: 'https://office.tail1.ts.net:7681', addedAt: 1 }]) },
  });
  useStore.setState({ toasts: [], remoteWorkspaces: [], pcRailHostStatus: {}, pcRailHosts: [] });
  useStore.getState().setA2aRemote({ hosts: [], links: [], joined: [], loaded: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount() {
  await act(async () => root.render(<Probe />));
}

describe('useConnectionDropNotice', () => {
  it('an A2A blip that reconnects inside the grace raises nothing', async () => {
    a2a('connected');
    await mount();
    await act(async () => { a2a('connecting'); });
    await advance(A2A_DROP_GRACE_MS - 2_000);
    await act(async () => { a2a('connected'); });
    await advance(60_000);
    expect(toasts()).toHaveLength(0);
  });

  it('a real A2A drop is reported once its grace has passed, naming Tailscale, and goes away on recovery', async () => {
    a2a('connected');
    await mount();
    await act(async () => { a2a('connecting'); });
    expect(tailscaleCheck).toHaveBeenCalledWith('100.101.12.4');
    await advance(A2A_DROP_GRACE_MS - 2_000);
    expect(toasts()).toHaveLength(0);
    await advance(4_000);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toMatch(/DESK/);
    expect(toasts()[0].message).toMatch(/Tailscale is off/);
    // Its button opens Tailscale, and only when clicked.
    expect(tailscaleOpen).not.toHaveBeenCalled();
    toasts()[0].action?.onClick();
    expect(tailscaleOpen).toHaveBeenCalledWith('app');
    await advance(60_000);
    expect(toasts()).toHaveLength(1);
    await act(async () => { a2a('connected'); });
    expect(toasts()).toHaveLength(0);
  });

  it('does not blame Tailscale for a PC reached over the LAN', async () => {
    a2a('connected', '192.168.0.12');
    await mount();
    await act(async () => { a2a('disconnected', '192.168.0.12'); });
    await advance(A2A_DROP_GRACE_MS + 2_000);
    expect(tailscaleCheck).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).not.toMatch(/Tailscale/);
  });

  it('a PC already down when wmux started, or connected with no link in use, raises nothing', async () => {
    a2a('disconnected');
    await mount();
    await advance(120_000);
    expect(toasts()).toHaveLength(0);
    useStore.getState().setA2aRemote({ links: [] });
    await act(async () => { a2a('connected'); useStore.getState().setA2aRemote({ links: [] }); });
    await act(async () => { a2a('disconnected'); useStore.getState().setA2aRemote({ links: [] }); });
    await advance(120_000);
    expect(toasts()).toHaveLength(0);
  });

  it('a workspace share: one failed poll healed by the 20 s retry is a blip; staying down past 25 s is reported', async () => {
    share('reachable');
    await mount();
    await act(async () => { share('unreachable'); });
    await advance(20_000);
    await act(async () => { share('reachable'); });
    await advance(60_000);
    expect(toasts()).toHaveLength(0);

    await act(async () => { share('unreachable'); });
    await advance(SHARE_DROP_GRACE_MS + 2_000);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].message).toMatch(/office/);
    expect(tailscaleCheck).toHaveBeenCalledWith('office.tail1.ts.net');
  });
});
