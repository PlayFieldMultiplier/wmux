// The receiver's offer RPCs (`a2a.remote.offers.accept` / `.decline`) and the
// refresh rule for an answer that never reached the sharer, against real
// stores and a scripted sharer behind the client seam.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_LINK_OFFER, A2A_OFFER_TTL_MS, A2A_ROUTES, type A2aRemoteHostRecordV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteOfferResult } from '../../../shared/rpc';
import { ExposedPaneCache } from '../exposedPanes';
import { ExposureStore } from '../exposureStore';
import type { JsonClient } from '../joiner';
import { registerA2aLinkRpc } from '../linkRpc';
import { LinkStore } from '../linkStore';
import { OfferStore } from '../offerStore';
import { A2aOffers } from '../offers';
import { PinnedClientError } from '../pinnedClient';

const B = '22222222-2222-4222-8222-222222222222';
const OFFER = '33333333-3333-4333-8333-333333333333';
const A_PANE = { kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-a', label: 'w1-1', workspaceName: 'Web' };
const both = { outbound: true, inbound: true };

type Script = (method: string, path: string, body: unknown) => Promise<{ status: number; json: unknown }>;

let dir: string;
let links: LinkStore;
let store: OfferStore;
let offers: A2aOffers;
let calls: Array<{ method: string; path: string; body: unknown }>;
let script: Script;
let rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-offers-rpc-'));
  const base = { dir, scheduleHarden: (): void => undefined };
  let offersRef: A2aOffers | null = null;
  links = new LinkStore({ ...base, onTransition: (l) => offersRef?.onLinkTransition(l) });
  const exposures = new ExposureStore(base);
  store = new OfferStore(base);
  offers = new A2aOffers({
    store,
    links,
    exposures,
    isPeer: () => false,
    isJoined: (h) => h === B,
    features: () => new Set([A2A_FEATURE_LINK_OFFER]),
    enqueue: () => undefined,
    notifyLinkChange: () => undefined,
    broadcast: () => undefined,
    log: () => undefined,
  });
  offersRef = offers;
  calls = [];
  script = async () => ({ status: 500, json: {} });
  const host = { hostId: B, name: 'PC-B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AA', peerId: 'p', v: 1, createdAt: '' } as unknown as A2aRemoteHostRecordV1;
  const client = (): JsonClient => ({
    requestJson: async (method, p, body) => {
      calls.push({ method, path: p, body });
      return script(method, p, body);
    },
  });
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  registerA2aLinkRpc((m, h) => handlers.set(m, h), {
    links,
    exposures,
    panes: new ExposedPaneCache(),
    remoteHosts: { get: (h) => (h === B ? host : undefined), credentialFor: (h) => (h === B ? { peerId: 'p', secret: 's' } : null) },
    broadcast: () => undefined,
    offers,
    client,
    log: () => undefined,
  });
  rpc = (method, params = {}) => handlers.get(method)!(params);
  // B's offer of its ws-api/pane-1, already received here.
  store.receiveIn({
    offerId: OFFER,
    hostId: B,
    end: { kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-1', label: 'w1-1(claude)' },
    allow: both,
    ttlMs: A2A_OFFER_TTL_MS,
  });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const accept = (o: Record<string, unknown> = {}): Promise<A2aRemoteOfferResult> =>
  rpc('a2a.remote.offers.accept', { offerId: OFFER, local: A_PANE, allow: both, ...o }) as Promise<A2aRemoteOfferResult>;

describe('a2a.remote.offers.accept', () => {
  it('sends one proposal naming the offer and applies the sharer’s active answer', async () => {
    script = async (_m, _p, body) => ({ status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'active', version: 2 } });
    const res = await accept();
    expect(res).toMatchObject({ ok: true, offer: { state: 'accepted' }, link: { state: 'active', version: 2 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: A2A_ROUTES.links, body: { offerId: OFFER, to: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, from: { paneId: 'pane-a' } } });
    expect(store.get(OFFER)?.linkId).toBe((calls[0].body as { linkId: string }).linkId);
  });

  it('succeeds when the stream notice made the link active before the answer arrived', async () => {
    script = async (_m, _p, body) => {
      const linkId = (body as { linkId: string }).linkId;
      links.applyRemoteAccept(linkId, 2); // the sharer's `active` notice won the race
      return { status: 200, json: { linkId, state: 'active', version: 2 } };
    };
    expect(await accept()).toMatchObject({ ok: true, offer: { state: 'accepted' }, link: { state: 'active' } });
  });

  it('never asks for more directions than offered, and needs at least one', async () => {
    store.end(OFFER, 'withdrawn', 'withdrawn');
    store.receiveIn({ offerId: '44444444-4444-4444-8444-444444444444', hostId: B, end: { kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-2' }, allow: { outbound: true, inbound: false }, ttlMs: A2A_OFFER_TTL_MS });
    script = async (_m, _p, body) => ({ status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'active', version: 2 } });
    await rpc('a2a.remote.offers.accept', { offerId: '44444444-4444-4444-8444-444444444444', local: A_PANE, allow: both });
    expect((calls[0].body as { allow: unknown }).allow).toEqual({ outbound: true, inbound: false });
    expect(await rpc('a2a.remote.offers.accept', { offerId: OFFER, local: A_PANE, allow: { outbound: false, inbound: false } })).toMatchObject({ ok: false });
  });

  it('an older sharer answers proposed-in: accepted here, the link waits for its human', async () => {
    script = async (_m, _p, body) => ({ status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'proposed-in' } });
    expect(await accept()).toMatchObject({ ok: true, offer: { state: 'accepted' }, link: { state: 'proposed-out' } });
  });

  it('offer-closed ends the offer here with the sharer’s reason and drops the proposal', async () => {
    script = async () => ({ status: 409, json: { ok: false, error: 'offer-closed', reason: 'expired' } });
    expect(await accept()).toEqual({ ok: false, error: 'offer-closed', reason: 'expired' });
    expect(store.get(OFFER)).toMatchObject({ state: 'expired', endedReason: 'expired' });
    expect(links.list()).toEqual([]);
  });

  it('another refusal drops the proposal and keeps the offer open to try again', async () => {
    script = async () => ({ status: 403, json: { ok: false, error: 'forbidden' } });
    expect(await accept()).toMatchObject({ ok: false, error: 'forbidden' });
    expect(store.get(OFFER)).toMatchObject({ state: 'open' });
    expect(store.get(OFFER)?.pendingLinkId).toBeUndefined();
    expect(links.list()).toEqual([]);
  });

  it('sent with no answer keeps the proposal; the retry resends the same link, a different pane is refused', async () => {
    script = async () => {
      throw new PinnedClientError('timeout', 'no answer', { sent: true });
    };
    expect(await accept()).toMatchObject({ ok: false, uncertain: true });
    const pending = store.get(OFFER)?.pendingLinkId;
    expect(pending).toBeDefined();
    expect(await accept({ local: { ...A_PANE, paneId: 'pane-z' } })).toMatchObject({ ok: false, error: 'invalid-state' });
    script = async (_m, _p, body) => ({ status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'active', version: 2 } });
    expect(await accept()).toMatchObject({ ok: true, link: { linkId: pending, state: 'active' } });
    expect((calls[calls.length - 1].body as { linkId: string }).linkId).toBe(pending);
  });

  it('Check on a proposal the sharer never got drops it and keeps the offer open', async () => {
    script = async () => {
      throw new PinnedClientError('timeout', 'no answer', { sent: true });
    };
    await accept();
    const pending = store.get(OFFER)!.pendingLinkId!;
    script = async () => ({ status: 404, json: { ok: false, error: 'unknown-link' } });
    expect(await rpc('a2a.remote.links.refresh', { linkId: pending })).toMatchObject({ ok: false, error: 'unknown-link' });
    expect(links.get(pending)).toBeUndefined();
    expect(store.get(OFFER)).toMatchObject({ state: 'open' });
    expect(store.get(OFFER)?.pendingLinkId).toBeUndefined();
  });

  it('refuses an offer that is no longer open', async () => {
    store.end(OFFER, 'withdrawn', 'withdrawn');
    expect(await accept()).toEqual({ ok: false, error: 'offer-closed', reason: 'withdrawn' });
    expect(calls).toEqual([]);
  });
});

describe('a2a.remote.offers.accept — review fixes', () => {
  it('a Check while the POST is still out does not drop the proposal', async () => {
    let release: () => void = () => undefined;
    script = async (method, _p, body) => {
      if (method === 'GET') return { status: 404, json: { ok: false, error: 'unknown-link' } };
      await new Promise<void>((r) => { release = r; });
      return { status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'active', version: 2 } };
    };
    const pending = accept();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true), { timeout: 5_000 });
    const linkId = store.get(OFFER)!.pendingLinkId!;
    await rpc('a2a.remote.links.refresh', { linkId });
    expect(links.get(linkId)?.state).toBe('proposed-out');
    release();
    expect(await pending).toMatchObject({ ok: true, offer: { state: 'accepted' }, link: { linkId, state: 'active' } });
  });

  it('a Check answered before the accept landed, but read after it, leaves the now active link alone', async () => {
    let releaseGet: () => void = () => undefined;
    script = async (method, _p, body) => {
      if (method === 'GET') {
        await new Promise<void>((r) => { releaseGet = r; });
        return { status: 404, json: { ok: false, error: 'unknown-link' } };
      }
      return { status: 200, json: { linkId: (body as { linkId: string }).linkId, state: 'active', version: 2 } };
    };
    // First answer unsettled, so a Check has something to ask about.
    const first = script;
    script = async () => {
      throw new PinnedClientError('timeout', 'no answer', { sent: true });
    };
    await accept();
    script = first;
    const linkId = store.get(OFFER)!.pendingLinkId!;
    const check = rpc('a2a.remote.links.refresh', { linkId });
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true), { timeout: 5_000 });
    expect(await accept()).toMatchObject({ ok: true, link: { linkId, state: 'active' } });
    releaseGet();
    await check;
    expect(links.get(linkId)?.state).toBe('active');
  });

  it('a sharer that took the offer but has not finished the link keeps it open; the same proposal again finishes it', async () => {
    let finished = false;
    script = async (_m, _p, body) => {
      const linkId = (body as { linkId: string }).linkId;
      return finished ? { status: 200, json: { linkId, state: 'active', version: 2 } } : { status: 200, json: { linkId, state: 'proposed-in', offerClaimed: true } };
    };
    expect(await accept()).toMatchObject({ ok: false, error: 'unavailable' });
    const linkId = store.get(OFFER)!.pendingLinkId!;
    expect(store.get(OFFER)?.state).toBe('open');
    finished = true;
    expect(await accept()).toMatchObject({ ok: true, link: { linkId, state: 'active' } });
  });
});

describe('a2a.remote.offers.accept — retries keep one answer', () => {
  it('a sharer not ready yet (503) keeps the proposal, and the retry sends the same one', async () => {
    let ready = false;
    script = async (_m, _p, body) => {
      const linkId = (body as { linkId: string }).linkId;
      return ready ? { status: 200, json: { linkId, state: 'active', version: 2 } } : { status: 503, json: { ok: false, error: 'unavailable' } };
    };
    expect(await accept()).toMatchObject({ ok: false, error: 'unavailable' });
    const linkId = store.get(OFFER)!.pendingLinkId!;
    expect(links.get(linkId)?.state).toBe('proposed-out');
    ready = true;
    expect(await accept()).toMatchObject({ ok: true, link: { linkId, state: 'active' } });
  });

  it('a retry with narrower directions than the unsettled answer is refused, not silently widened', async () => {
    script = async () => ({ status: 503, json: { ok: false, error: 'unavailable' } });
    await accept();
    expect(await accept({ allow: { outbound: true, inbound: false } })).toMatchObject({ ok: false, error: 'invalid-state' });
  });
});

describe('a2a.remote.offers.decline', () => {
  it('ends the offer here and tells the sharer', async () => {
    script = async () => ({ status: 200, json: { ok: true, state: 'declined' } });
    expect(await rpc('a2a.remote.offers.decline', { offerId: OFFER })).toMatchObject({ ok: true, offer: { state: 'declined' } });
    expect(calls).toEqual([{ method: 'POST', path: `${A2A_ROUTES.offers}/${OFFER}${A2A_ROUTES.offerDeclineSuffix}`, body: {} }]);
  });

  it('waits while an answer to the offer is unsettled', async () => {
    script = async () => {
      throw new PinnedClientError('timeout', 'no answer', { sent: true });
    };
    await accept();
    expect(await rpc('a2a.remote.offers.decline', { offerId: OFFER })).toMatchObject({ ok: false, error: 'invalid-state' });
  });
});
