// @vitest-environment jsdom
// The Remote page as the one place for PC connections (2026-10-22): every
// record the daemon already holds shows up, what this PC allows each PC reads
// on its row, an A2A PC and a LanLink peer never share a row, a revoked peer
// leaves within one poll, and a PC that joined this one and has not connected
// reads as offline with when it was last seen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemotePage, { REMOTE_PAGE_POLL_MS } from '../RemotePage';
import type { A2aExposureV1, A2aLinkRecordV1, A2aPeerRecordV1, A2aRemoteHostRecordV1 } from '../../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';
import type { LanLinkPeerSummary } from '../../../../shared/lanlink';

const JOINED = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const HOUR = 3_600_000;

let container: HTMLDivElement;
let root: Root;
type Fns = Record<string, ReturnType<typeof vi.fn>>;
let api: { web: Fns; remote: Fns; lanlink: Fns; a2aRemote: Fns };

/** What the daemon holds: config, lanlink peers, A2A peers and hosts, remote hosts, exposure, links. */
interface Fixture {
  joined?: A2aRemoteHostRecordV1[];
  peers?: A2aPeerRecordV1[];
  status?: A2aRemoteHostStatus[];
  lanPeers?: LanLinkPeerSummary[];
  remoteHosts?: unknown[];
  exposure?: Record<string, A2aExposureV1 | null>;
  links?: A2aLinkRecordV1[];
}

const joinedHost = (over: Partial<A2aRemoteHostRecordV1> = {}): A2aRemoteHostRecordV1 => ({
  v: 1, hostId: JOINED, name: 'BUILD-BOX', addresses: ['build-box'], port: 45660,
  fingerprint256: '3F:9A:12:C0:7B:E4:91:0D' as never, peerId: 'my-peer', createdAt: '2026-10-01T00:00:00.000Z', ...over,
} as A2aRemoteHostRecordV1);
const peer = (over: Partial<A2aPeerRecordV1> = {}): A2aPeerRecordV1 => ({
  v: 1, peerId: 'peer-1', hostId: PEER, name: 'DESK', createdAt: '2026-10-01T00:00:00.000Z', ...over,
});
const lanPeer = (over: Partial<LanLinkPeerSummary> = {}): LanLinkPeerSummary => ({
  peerUuid: 'lan-uuid-1', peerName: 'DESK', pairedAt: 1, lastSeenAt: Date.now() - HOUR, burned: false, ...over,
});

function stub(fx: Fixture) {
  const state = { ...fx };
  api = {
    web: {
      status: vi.fn(async () => ({ running: false })),
      deviceList: vi.fn(async () => ({ devices: [] })),
      deviceRevoke: vi.fn(async () => ({ ok: true })),
    },
    remote: {
      hostsList: vi.fn(async () => state.remoteHosts ?? []),
      hostsRemove: vi.fn(async () => undefined),
    },
    lanlink: {
      peersList: vi.fn(async () => ({ peers: state.lanPeers ?? [] })),
      peersRemove: vi.fn(async () => ({ ok: true })),
    },
    a2aRemote: {
      status: vi.fn(async () => ({ enabled: true, port: 45660, listening: true, hostId: 'me', name: 'MAC', fingerprint256: null, lastError: null })),
      linksList: vi.fn(async () => ({ links: state.links ?? [] })),
      offersList: vi.fn(async () => ({ offers: [] })),
      hostsStatus: vi.fn(async () => ({ hosts: state.status ?? [] })),
      heldList: vi.fn(async () => ({ tasks: [] })),
      hostsList: vi.fn(async () => ({ hosts: state.joined ?? [] })),
      peersList: vi.fn(async () => ({ peers: state.peers ?? [] })),
      exposureGet: vi.fn(async (hostId: string) => ({ exposure: state.exposure?.[hostId] ?? null })),
      hostsRemove: vi.fn(async () => ({ ok: true, remoteRevoked: true })),
      peersRevoke: vi.fn(async () => ({ ok: true })),
    },
  };
  vi.stubGlobal('electronAPI', { platform: 'darwin', ...api });
  vi.stubGlobal('clipboardAPI', { readText: vi.fn(async () => ''), writeText: vi.fn(async () => undefined) });
  return state;
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function render() {
  await act(async () => root.render(<RemotePage />));
  await settle();
}
async function poll() {
  await act(async () => { vi.advanceTimersByTime(REMOTE_PAGE_POLL_MS); });
  await settle();
}
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = {
    id: 'w1', name: 'api', wsOrdinal: 1, activePaneId: 'p1',
    rootPane: {
      id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
      children: [
        { id: 'p1', type: 'leaf', ordinal: 1, activeSurfaceId: 's1', surfaces: [{ id: 's1', ptyId: 'pty-1' }] },
        { id: 'p2', type: 'leaf', ordinal: 2, activeSurfaceId: 's2', surfaces: [{ id: 's2', ptyId: 'pty-2' }] },
      ],
    },
  };
  useStore.setState({
    remoteWorkspaces: [], workspaces: [ws as never], appRoute: 'remote',
    a2aRemote: { links: [], offers: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Remote page connections', () => {
  it('shows every record the daemon holds: joined PCs, PCs that joined, workspace shares, LAN peers, exposure and links', async () => {
    stub({
      joined: [joinedHost()],
      peers: [peer()],
      status: [{ hostId: JOINED, name: 'BUILD-BOX', role: 'joiner', state: 'connected', pending: 0 }],
      lanPeers: [lanPeer({ peerName: 'LAB-PC' })],
      remoteHosts: [{ id: 'rh1', label: 'office-mini', origin: 'https://office.ts.net', addedAt: 1 }],
      exposure: { [PEER]: { v: 1, hostId: PEER, workspaceIds: ['w1'], paneIds: { w1: ['p1', 'p2'] }, updatedAt: '' } },
      links: [{
        v: 1, linkId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, state: 'active',
        local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' },
        remote: { hostId: JOINED, kind: 'pane', workspaceId: 'rw', paneId: 'rp', workspaceName: 'Web', label: 'claude' },
        allow: { outbound: true, inbound: true }, proposer: 'local', createdAt: '', updatedAt: '',
      } as A2aLinkRecordV1],
    });
    await render();
    const joinedRow = $(`[data-remote-pc="${JOINED}"]`)!;
    expect(joinedRow.textContent).toContain('BUILD-BOX');
    expect(joinedRow.textContent).toContain('Pane links 1');
    expect($('[data-testid="a2a-link-row"]')).not.toBeNull();
    const peerRow = $(`[data-remote-pc="${PEER}"]`)!;
    expect(peerRow.textContent).toContain('DESK');
    expect(peerRow.querySelector('[data-perm-slot="see"]')?.textContent).toBe('Can see 2 panes here');
    expect(api.a2aRemote.exposureGet).toHaveBeenCalledWith(PEER);
    expect($('[data-remote-entry="host"]')?.textContent).toContain('office-mini');
    expect($('[data-remote-entry="peer"]')?.textContent).toContain('LAB-PC');
  });

  it('reserves an empty slot for a future permission on every PC row, and a PC this PC joined claims nothing it does not set', async () => {
    stub({ joined: [joinedHost()], peers: [peer()] });
    await render();
    for (const id of [JOINED, PEER]) {
      const row = $(`[data-remote-pc="${id}"]`)!;
      expect(row.querySelector('[data-remote-perm]')).not.toBeNull();
      expect(row.querySelector('[data-perm-slot="agents"]')?.textContent).toBe('');
    }
    expect($(`[data-remote-pc="${JOINED}"] [data-perm-slot="see"]`)?.textContent).toBe('');
  });

  it('a PC that just joined can see nothing until a pane is ticked', async () => {
    stub({ peers: [peer()], exposure: { [PEER]: null } });
    await render();
    expect($(`[data-remote-pc="${PEER}"] [data-perm-slot="see"]`)?.textContent).toBe('Can see nothing here');
  });

  it('keeps an A2A PC and a LAN peer with the same name as two rows, and removing one leaves the other', async () => {
    const state = stub({ peers: [peer({ name: 'DESK' })], lanPeers: [lanPeer({ peerName: 'DESK' })] });
    await render();
    expect($(`[data-remote-pc="${PEER}"]`)?.textContent).toContain('DESK');
    const lan = $('[data-remote-entry="peer"]')!;
    expect(lan.textContent).toContain('DESK');
    act(() => lan.querySelector<HTMLButtonElement>('[data-remote-remove="peer"]')!.click());
    state.lanPeers = [];
    await act(async () => { $<HTMLButtonElement>('[data-remote-confirm="peer"]')!.click(); });
    await settle();
    expect(api.lanlink.peersRemove).toHaveBeenCalledWith('lan-uuid-1');
    expect(api.a2aRemote.peersRevoke).not.toHaveBeenCalled();
    expect(api.a2aRemote.hostsRemove).not.toHaveBeenCalled();
    expect($('[data-remote-entry="peer"]')).toBeNull();
    expect($(`[data-remote-pc="${PEER}"]`)?.textContent).toContain('DESK');
  });

  it('drops a revoked PC and a removed LAN peer within one poll', async () => {
    const state = stub({ peers: [peer()], lanPeers: [lanPeer()] });
    await render();
    expect($(`[data-remote-pc="${PEER}"]`)).not.toBeNull();
    expect($$('[data-remote-entry="peer"]')).toHaveLength(1);
    state.peers = [peer({ revokedAt: new Date().toISOString() })];
    state.lanPeers = [];
    await poll();
    expect($(`[data-remote-pc="${PEER}"]`)).toBeNull();
    expect($('[data-remote-entry="peer"]')).toBeNull();
  });

  it('a PC known only as a joiner reads as disconnected with when it was last seen, not Waiting', async () => {
    stub({ peers: [peer({ lastSeenAt: new Date(Date.now() - 3 * HOUR).toISOString() })] });
    await render();
    const st = $(`[data-remote-pc="${PEER}"] .wmux-remote-st`)!;
    expect(st.getAttribute('data-status')).toBe('disconnected');
    expect(st.textContent).toMatch(/^Disconnected 3h ago$/);
  });

  it('keeps a revoked LAN peer\'s state on its row', async () => {
    stub({ lanPeers: [lanPeer({ burned: true })] });
    await render();
    expect($('[data-remote-entry="peer"] .wmux-remote-meta')?.textContent).toContain('Revoked');
  });
});
