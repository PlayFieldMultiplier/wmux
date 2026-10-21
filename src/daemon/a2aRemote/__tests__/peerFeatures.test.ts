// What a paired PC takes, as a sender asks it: live from either stream, else
// the last seen value kept across a daemon restart (peer-features.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A2aRemoteDelivery, type A2aRemoteDeliveryDeps } from '../delivery';
import { PeerFeatureStore, PEER_FEATURES_FILE } from '../peerFeatureStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-feat-'));
  dirs.push(d);
  return d;
}
const quiet = (): void => undefined;

interface World {
  peers: Array<{ hostId: string; revokedAt?: string }>;
  joined: string[];
}

function delivery(dir: string, world: World = { peers: [], joined: [] }): A2aRemoteDelivery {
  const deps = {
    dir,
    links: { list: () => [] },
    taskService: {},
    peers: { list: () => world.peers },
    remoteHosts: {
      list: () => world.joined.map((hostId) => ({ hostId, fingerprint256: 'f', port: 1, addresses: ['127.0.0.1'] })),
      get: (h: string) => (world.joined.includes(h) ? { hostId: h } : undefined),
      credentialFor: () => null,
    },
    broadcast: quiet,
    refreshLink: async () => null,
    log: quiet,
  } as unknown as A2aRemoteDeliveryDeps;
  return new A2aRemoteDelivery(deps);
}

describe('PeerFeatureStore', () => {
  it('keeps both roles per host across a reload and writes only on a change', () => {
    const dir = tmp();
    const writes: unknown[] = [];
    const store = new PeerFeatureStore({
      dir,
      scheduleHarden: quiet,
      write: (p, d) => {
        writes.push(d);
        fs.writeFileSync(p, JSON.stringify(d));
      },
    });
    store.record(HOST, 'asJoiner', ['link-offer.1']);
    store.record(HOST, 'asServer', ['images.1', 'link-offer.1']);
    store.record(HOST, 'asServer', ['images.1', 'link-offer.1']);
    expect(writes).toHaveLength(2);
    const again = new PeerFeatureStore({ dir, scheduleHarden: quiet });
    expect(again.get(HOST)).toMatchObject({ asJoiner: { features: ['link-offer.1'] }, asServer: { features: ['images.1', 'link-offer.1'] } });
  });

  it('answers from the role advertised last: a downgrade in one role is not hidden by the other', () => {
    const dir = tmp();
    let t = Date.parse('2026-10-22T00:00:00Z');
    const now = (): number => (t += 1000);
    const store = new PeerFeatureStore({ dir, now, scheduleHarden: quiet });
    store.record(HOST, 'asServer', ['images.1', 'link-offer.1']);
    store.record(HOST, 'asJoiner', ['images.1', 'link-offer.1']);
    // The peer moved to a build without images; its stream to us came back first.
    store.record(HOST, 'asJoiner', ['link-offer.1']);
    expect(store.newest(HOST)).toEqual(['link-offer.1']);
    expect(new PeerFeatureStore({ dir, now, scheduleHarden: quiet }).newest(HOST)).toEqual(['link-offer.1']);
    // Back on a build with images: the unchanged server list now answers, after a restart too.
    store.record(HOST, 'asServer', ['images.1', 'link-offer.1']);
    expect(store.newest(HOST)).toEqual(['images.1', 'link-offer.1']);
    expect(new PeerFeatureStore({ dir, now, scheduleHarden: quiet }).newest(HOST)).toEqual(['images.1', 'link-offer.1']);
  });

  it('starts empty on a corrupt file and keeps the original aside', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, PEER_FEATURES_FILE), '{"v":1,"hosts":{"not-a-host":{}}}');
    const store = new PeerFeatureStore({ dir, scheduleHarden: quiet });
    expect(store.get(HOST)).toBeUndefined();
    expect(fs.readdirSync(dir).some((f) => f.startsWith(`${PEER_FEATURES_FILE}.corrupt-`))).toBe(true);
  });
});

describe('A2aRemoteDelivery.peerFeatures', () => {
  it('answers from the last seen features after a restart, and undefined for a never-seen PC', () => {
    const dir = tmp();
    const first = delivery(dir);
    expect(first.peerFeatures(HOST)).toBeUndefined();
    first.peerFeatureStore.record(HOST, 'asJoiner', ['images.1']);
    // A new daemon: nothing live yet, the file answers.
    const second = delivery(dir);
    expect(second.hub.featuresOf(HOST)).toBeUndefined();
    expect([...(second.peerFeatures(HOST) ?? [])]).toEqual(['images.1']);
  });

  it('forgets a PC revoked here unless this PC also joined it', () => {
    const world: World = { peers: [{ hostId: HOST }], joined: [HOST] };
    const d = delivery(tmp(), world);
    d.peerFeatureStore.record(HOST, 'asJoiner', ['images.1']);
    d.onPeerRevoked(HOST);
    expect(d.peerFeatures(HOST)).toBeDefined();
    world.joined = [];
    d.onPeerRevoked(HOST);
    expect(d.peerFeatures(HOST)).toBeUndefined();
  });

  it('forgets a PC this one left when it is not paired the other way', async () => {
    const world: World = { peers: [{ hostId: HOST }], joined: [HOST] };
    const d = delivery(tmp(), world);
    d.syncSessions();
    d.peerFeatureStore.record(HOST, 'asServer', ['images.1']);
    // Left, but it still joins this PC: kept.
    world.joined = [];
    d.syncSessions();
    expect(d.peerFeatures(HOST)).toBeDefined();
    // Joined again and left again, now unpaired both ways: forgotten.
    world.joined = [HOST];
    d.syncSessions();
    world.joined = [];
    world.peers = [{ hostId: HOST, revokedAt: '2026-10-22T00:00:00Z' }];
    d.syncSessions();
    expect(d.peerFeatures(HOST)).toBeUndefined();
    await d.stop();
  });
});
