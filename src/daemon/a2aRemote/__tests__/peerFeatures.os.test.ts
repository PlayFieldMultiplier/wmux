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

function delivery(dir: string): A2aRemoteDelivery {
  const deps = {
    dir,
    links: { list: () => [] },
    taskService: {},
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
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
    expect(again.get(HOST)).toMatchObject({ asJoiner: ['link-offer.1'], asServer: ['images.1', 'link-offer.1'] });
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
});
