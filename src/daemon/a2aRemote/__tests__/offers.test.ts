// Share offers between two in-process "PCs" without the network: B (the
// server, sharer) and A (the joiner, receiver). B's outbox is a list the test
// hands to A's inbound; A's accept is B's offer path of POST /api/a2a/links.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A2A_FEATURE_LINK_OFFER,
  A2A_OFFER_TTL_MS,
  A2A_REMOTE_PROTOCOL,
  type A2aExposedPane,
  type A2aLinkProposeRequest,
  type A2aLinkRecordV1,
  type A2aRemoteEnvelope,
} from '../../../shared/a2aRemote';
import { ExposureStore } from '../exposureStore';
import { LinkStore } from '../linkStore';
import { OfferStore } from '../offerStore';
import { A2aOffers, type A2aOfferEvent } from '../offers';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { OutboxStore } from '../outboxStore';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const B_PANE: A2aExposedPane = { kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-1', label: 'w1-1(claude)', agent: 'claude', cwd: '/srv/api', gitRemote: 'github.com/acme/api' };
const A_PANE = { kind: 'pane' as const, workspaceId: 'ws-web', paneId: 'pane-a', label: 'w1-1(codex)', workspaceName: 'Web' };
const both = { outbound: true, inbound: true };

interface Side {
  hostId: string;
  dir: string;
  store: OfferStore;
  links: LinkStore;
  exposures: ExposureStore;
  offers: A2aOffers;
  outbox: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
  notices: Array<{ hostId: string; linkId: string; state: string; version: number }>;
  events: A2aOfferEvent[];
  clock: { now: number };
  failWrites: { on: boolean; exposure: boolean };
}

function makeSide(hostId: string, other: string, opts: { features?: string[] | null; dir?: string; clock?: { now: number }; appReady?: () => boolean } = {}): Side {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-offers-'));
  if (!opts.dir) dirs.push(dir);
  const clock = opts.clock ?? { now: 1_700_000_000_000 };
  const failWrites = { on: false, exposure: false };
  const write = (p: string, d: unknown): void => {
    if (failWrites.on && p.endsWith('links.json')) throw new Error('disk full');
    atomicWriteJSONSync(p, d);
  };
  const exposureWrite = (p: string, d: unknown): void => {
    if (failWrites.exposure) throw new Error('disk full');
    atomicWriteJSONSync(p, d);
  };
  const base = { dir, now: () => clock.now, scheduleHarden: (): void => undefined };
  let offersRef: A2aOffers | null = null;
  const links = new LinkStore({ ...base, write, onTransition: (l) => offersRef?.onLinkTransition(l) });
  const exposures = new ExposureStore({ ...base, write: exposureWrite });
  const store = new OfferStore(base);
  const outbox: Side['outbox'] = [];
  const notices: Side['notices'] = [];
  const events: A2aOfferEvent[] = [];
  const features = opts.features === undefined ? [A2A_FEATURE_LINK_OFFER] : opts.features;
  const offers = new A2aOffers({
    store,
    links,
    exposures,
    isPeer: (h) => h === other,
    isJoined: (h) => h === other,
    features: (h) => (h === other && features !== null ? new Set(features) : undefined),
    enqueue: (h, env) => void outbox.push({ hostId: h, env }),
    notifyLinkChange: (h, linkId, state, version) => void notices.push({ hostId: h, linkId, state, version }),
    broadcast: (e) => void events.push(e),
    log: () => undefined,
    now: () => clock.now,
    ...(opts.appReady ? { appReady: opts.appReady } : {}),
  });
  offersRef = offers;
  return { hostId, dir, store, links, exposures, offers, outbox, notices, events, clock, failWrites };
}

/** Hand every queued envelope from `from` to `to`'s inbound. */
async function flush(from: Side, to: Side): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const { env } of from.outbox.splice(0)) out.push(await to.offers.applyInbound(env, { hostId: from.hostId }));
  return out;
}

/** A's proposal for an offer, as A's accept RPC builds it (from A's link record). */
function proposalFor(a: Side, offerId: string, local = A_PANE, allow = both): { link: A2aLinkRecordV1; request: A2aLinkProposeRequest } {
  const rec = a.store.get(offerId)!;
  const link = a.links.proposeOut({
    local: { kind: 'pane', workspaceId: local.workspaceId, paneId: local.paneId },
    remote: { hostId: rec.hostId, kind: 'pane', workspaceId: rec.end.workspaceId, paneId: rec.end.paneId, label: rec.end.label, workspaceName: rec.end.workspaceName },
    allow,
  });
  return {
    link,
    request: { linkId: link.linkId, offerId, from: local, to: { kind: 'pane', workspaceId: rec.end.workspaceId, paneId: rec.end.paneId }, allow },
  };
}

async function shared(): Promise<{ a: Side; b: Side; offerId: string }> {
  const a = makeSide(A, B);
  const b = makeSide(B, A);
  const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
  expect(made.ok).toBe(true);
  if (!made.ok) throw new Error('unreachable');
  expect(await flush(b, a)).toEqual([{ ok: true, duplicate: false }]);
  return { a, b, offerId: made.offer.offerId };
}

describe('share offers — sharer creates, receiver gets it', () => {
  it('create shows the pane to that PC and sends one offer envelope as a link notice', () => {
    const b = makeSide(B, A);
    const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    expect(made).toMatchObject({ ok: true, offer: { side: 'out', state: 'open', addedExposure: true, addedWorkspace: true } });
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(true);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-2')).toBe(false);
    expect(b.outbox).toHaveLength(1);
    const env = b.outbox[0].env;
    expect(env).toMatchObject({ protocol: A2A_REMOTE_PROTOCOL, kind: 'link', linkVersion: 0, link: { state: 'offer', version: 0 } });
    expect(env.linkId).toBe(made.ok && made.offer.offerId);
    expect(env.offer).toMatchObject({ end: { paneId: 'pane-1' }, allow: both, ttlMs: A2A_OFFER_TTL_MS });
  });

  it('a second share of the same pane returns the open offer and sends nothing more', () => {
    const b = makeSide(B, A);
    const first = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    const again = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    expect(again.ok && first.ok && again.offer.offerId === first.offer.offerId).toBe(true);
    expect(b.outbox).toHaveLength(1);
  });

  it('refuses cleanly when the other PC is unknown, not connected, or lacks the feature', () => {
    expect(makeSide(B, A).offers.create({ hostId: '33333333-3333-4333-8333-333333333333', end: B_PANE, allow: both })).toMatchObject({ ok: false, error: 'not-paired' });
    const offline = makeSide(B, A, { features: null });
    expect(offline.offers.create({ hostId: A, end: B_PANE, allow: both })).toMatchObject({ ok: false, error: 'not-connected' });
    const old = makeSide(B, A, { features: [] });
    expect(old.offers.create({ hostId: A, end: B_PANE, allow: both })).toMatchObject({ ok: false, error: 'receiver-unsupported' });
    expect(old.outbox).toEqual([]);
    expect(old.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('a pane already shown is not re-written and owes nothing back', () => {
    const b = makeSide(B, A);
    b.exposures.set(A, { workspaceIds: ['ws-api'] });
    const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    expect(made.ok && made.offer.addedExposure).toBeFalsy();
  });

  it('the receiver stores it with the directions flipped and the names sanitized', async () => {
    const a = makeSide(A, B);
    const b = makeSide(B, A);
    b.offers.create({ hostId: A, end: { ...B_PANE, label: 'evil\u001b]52;c;x\u0007name' }, allow: { outbound: true, inbound: false } });
    await flush(b, a);
    const [rec] = a.store.list();
    expect(rec).toMatchObject({ side: 'in', state: 'open', hostId: B, allow: { outbound: false, inbound: true } });
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(rec.end.label).not.toMatch(/[\u0000-\u001f]/);
    expect(a.events).toContainEqual({ type: 'a2a.remote.offer.changed', offerId: rec.offerId, side: 'in', state: 'open' });
  });

  it('the receiver answers a redelivery as a duplicate and a changed payload as a conflict', async () => {
    const a = makeSide(A, B);
    const b = makeSide(B, A);
    b.offers.create({ hostId: A, end: B_PANE, allow: both });
    const env = b.outbox[0].env;
    expect(await a.offers.applyInbound(env, { hostId: B })).toEqual({ ok: true, duplicate: false });
    expect(await a.offers.applyInbound(env, { hostId: B })).toEqual({ ok: true, duplicate: true });
    const changed = { ...env, messageId: crypto.randomUUID(), offer: { ...(env.offer as object), allow: { outbound: true, inbound: false } } };
    expect(await a.offers.applyInbound(changed as A2aRemoteEnvelope, { hostId: B })).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('a store that cannot write answers unavailable, so the stream sends the offer again', async () => {
    const a = makeSide(A, B);
    const b = makeSide(B, A);
    b.offers.create({ hostId: A, end: B_PANE, allow: both });
    const realReceive = a.store.receiveIn.bind(a.store);
    a.store.receiveIn = () => { throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }); };
    expect(await a.offers.applyInbound(b.outbox[0].env, { hostId: B })).toMatchObject({ ok: false, error: 'unavailable' });
    a.store.receiveIn = realReceive;
    expect(await a.offers.applyInbound(b.outbox[0].env, { hostId: B })).toEqual({ ok: true, duplicate: false });
  });

  it('the receiver refuses an offer from a PC it did not join', async () => {
    const a = makeSide(A, B);
    const b = makeSide(B, A);
    b.offers.create({ hostId: A, end: B_PANE, allow: both });
    expect(await a.offers.applyInbound(b.outbox[0].env, { hostId: '33333333-3333-4333-8333-333333333333' })).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

describe('share offers — the receiver accepts (B’s offer path of POST /links)', () => {
  it('a fitting proposal becomes an active link on B at once, and A applies the answer', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    const answer = b.offers.acceptProposal(A, request);
    expect(answer).toEqual({ status: 200, body: { linkId: link.linkId, state: 'active', version: 2 } });
    expect(b.links.get(link.linkId)).toMatchObject({ state: 'active', proposer: 'remote', local: { paneId: 'pane-1' }, remote: { hostId: A, paneId: 'pane-a' } });
    expect(b.store.get(offerId)).toMatchObject({ state: 'accepted', linkId: link.linkId });
    expect(b.notices).toEqual([{ hostId: A, linkId: link.linkId, state: 'active', version: 2 }]);
    expect(b.events).toContainEqual({ type: 'a2a.remote.offer.changed', offerId, side: 'out', state: 'accepted', linkId: link.linkId });
  });

  it('an unknown offer and another PC’s offer get the same 403', async () => {
    const { a, b, offerId } = await shared();
    const { request } = proposalFor(a, offerId);
    expect(b.offers.acceptProposal(A, { ...request, offerId: crypto.randomUUID() })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(b.offers.acceptProposal('33333333-3333-4333-8333-333333333333', request)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
  });

  it('refuses a different pane of B, and wider directions; narrower ones are fine', async () => {
    const { a, b, offerId } = await shared();
    const { request } = proposalFor(a, offerId);
    expect(b.offers.acceptProposal(A, { ...request, to: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-2' } }).status).toBe(403);
    // B offered A → B only (A may send); A asking for both directions is wider.
    const narrowB = makeSide(B, A);
    const made = narrowB.offers.create({ hostId: A, end: B_PANE, allow: { outbound: false, inbound: true } });
    if (!made.ok) throw new Error('create failed');
    const a2 = makeSide(A, B);
    await flush(narrowB, a2);
    const wide = proposalFor(a2, made.offer.offerId, A_PANE, both);
    expect(narrowB.offers.acceptProposal(A, wide.request).status).toBe(403);
    a2.links.discard(wide.link.linkId);
    const ok = proposalFor(a2, made.offer.offerId, A_PANE, { outbound: true, inbound: false });
    expect(narrowB.offers.acceptProposal(A, ok.request)).toMatchObject({ status: 200, body: { state: 'active' } });
    expect(narrowB.links.get(ok.link.linkId)?.allow).toEqual({ outbound: false, inbound: true });
  });

  it('refuses once the pane is no longer shown to that PC', async () => {
    const { a, b, offerId } = await shared();
    b.exposures.set(A, { workspaceIds: [] });
    expect(b.offers.acceptProposal(A, proposalFor(a, offerId).request).status).toBe(403);
  });

  it('a retry with the same link id answers the same; another link id or pane is refused as used', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    b.offers.acceptProposal(A, request);
    expect(b.offers.acceptProposal(A, request)).toEqual({ status: 200, body: { linkId: link.linkId, state: 'active', version: 2 } });
    expect(b.notices).toHaveLength(1);
    const other = { ...request, linkId: crypto.randomUUID(), from: { ...A_PANE, paneId: 'pane-z' } };
    expect(b.offers.acceptProposal(A, other)).toEqual({ status: 409, body: { ok: false, error: 'offer-closed', reason: 'used' } });
  });

  it('a link write that fails after the claim stays claimed; the retry finishes it', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    b.failWrites.on = true;
    expect(b.offers.acceptProposal(A, request)).toMatchObject({ status: 409, body: { error: 'conflict' } });
    // receiveProposal rolled back, so the claim went back to open.
    expect(b.store.get(offerId)?.state).toBe('open');
    b.failWrites.on = false;
    expect(b.offers.acceptProposal(A, request)).toMatchObject({ status: 200, body: { linkId: link.linkId, state: 'active' } });
  });

  it('a crash between claim and the link, and between the link and accept, both finish on retry', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    // Crash after the claim, before receiveProposal.
    b.store.claim(offerId, link.linkId);
    expect(b.offers.acceptProposal(A, request)).toMatchObject({ status: 200, body: { state: 'active', version: 2 } });

    const second = await shared();
    const p2 = proposalFor(second.a, second.offerId);
    // Crash after receiveProposal, before accept.
    second.b.store.claim(second.offerId, p2.link.linkId);
    second.b.links.receiveProposal({ linkId: p2.link.linkId, local: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, remote: { hostId: A, kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-a' }, allow: both });
    expect(second.b.offers.acceptProposal(A, p2.request)).toMatchObject({ status: 200, body: { state: 'active', version: 2 } });
    expect(second.b.store.get(second.offerId)?.state).toBe('accepted');
  });

  it('startup recovery settles claimed offers by what links.json holds', async () => {
    const { a, b, offerId } = await shared();
    const { link } = proposalFor(a, offerId);
    b.store.claim(offerId, link.linkId);
    b.links.receiveProposal({ linkId: link.linkId, local: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, remote: { hostId: A, kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-a' }, allow: both });
    b.offers.recover();
    expect(b.links.get(link.linkId)?.state).toBe('active');
    expect(b.store.get(offerId)?.state).toBe('accepted');
    expect(b.notices).toContainEqual({ hostId: A, linkId: link.linkId, state: 'active', version: 2 });

    const again = await shared();
    again.b.store.claim(again.offerId, crypto.randomUUID());
    again.b.offers.recover();
    expect(again.b.store.get(again.offerId)?.state).toBe('open');
  });
});

describe('share offers — ending one', () => {
  it('withdraw puts the exposure back and tells the receiver, which ends its copy', async () => {
    const { a, b, offerId } = await shared();
    expect(b.offers.withdraw(offerId)).toMatchObject({ ok: true, offer: { state: 'withdrawn' } });
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(b.exposures.get(A)?.workspaceIds).toEqual([]);
    expect(b.outbox[0].env).toMatchObject({ kind: 'link', linkId: offerId, link: { state: 'offer-withdrawn' }, offer: { reason: 'withdrawn' } });
    await flush(b, a);
    expect(a.store.get(offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'withdrawn' });
    expect(b.offers.acceptProposal(A, proposalFor(a, offerId).request)).toEqual({ status: 409, body: { ok: false, error: 'offer-closed', reason: 'withdrawn' } });
  });

  it('a decline from the receiver ends it and puts the exposure back; only its own PC may decline', async () => {
    const { b, offerId } = await shared();
    expect(b.offers.decline('33333333-3333-4333-8333-333333333333', offerId).status).toBe(403);
    expect(b.offers.decline(A, offerId)).toEqual({ status: 200, body: { ok: true, state: 'declined' } });
    expect(b.offers.decline(A, offerId)).toEqual({ status: 200, body: { ok: true, state: 'declined' } });
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('expiry ends it after an hour, puts the exposure back, and a late accept is refused', async () => {
    const { a, b, offerId } = await shared();
    b.clock.now += A2A_OFFER_TTL_MS + 1;
    expect(b.offers.acceptProposal(A, proposalFor(a, offerId).request)).toEqual({ status: 409, body: { ok: false, error: 'offer-closed', reason: 'expired' } });
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('closing, moving or unticking the pane ends the offer', async () => {
    const closed = await shared();
    closed.b.offers.onPaneGone({ workspaceId: 'ws-api', paneId: 'pane-1', reason: 'pane-closed' });
    expect(closed.b.store.get(closed.offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'pane-closed' });
    const gone = await shared();
    gone.b.offers.onPaneGone({ workspaceId: 'ws-api', reason: 'workspace-gone' });
    expect(gone.b.store.get(gone.offerId)?.endedReason).toBe('workspace-gone');
    const unticked = await shared();
    unticked.b.exposures.set(A, { workspaceIds: [] });
    unticked.b.offers.onExposureSetByHuman(A);
    expect(unticked.b.store.get(unticked.offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'exposure-revoked' });
  });

  it('a human edit of the exposure list takes ownership: nothing is put back later', async () => {
    const { b, offerId } = await shared();
    b.offers.onExposureSetByHuman(A);
    b.offers.withdraw(offerId);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(true);
  });

  it('a stream that comes back without the feature ends the open offers as unsupported', async () => {
    const { b, offerId } = await shared();
    b.offers.onPeerFeatures(A, []);
    expect(b.store.get(offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'receiver-unsupported' });
  });

  it('an older receiver refusing the offer envelope ends it as unsupported', async () => {
    const { b, offerId } = await shared();
    b.offers.create({ hostId: A, end: { ...B_PANE, paneId: 'pane-2' }, allow: both });
    const env = b.outbox[b.outbox.length - 1].env;
    b.offers.onRefused(A, env, 'unknown-link');
    expect(b.store.get(env.linkId)).toMatchObject({ state: 'withdrawn', endedReason: 'receiver-unsupported' });
    expect(b.store.get(offerId)?.state).toBe('open');
  });

  it('unlinking a share-made link hides the pane again; an already shown pane stays', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    b.offers.acceptProposal(A, request);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(true);
    b.links.revoke(link.linkId, 'local');
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);

    const pre = makeSide(B, A);
    const a2 = makeSide(A, B);
    pre.exposures.set(A, { workspaceIds: ['ws-api'], paneIds: { 'ws-api': ['pane-1'] } });
    const made = pre.offers.create({ hostId: A, end: B_PANE, allow: both });
    if (!made.ok) throw new Error('create failed');
    await flush(pre, a2);
    const p2 = proposalFor(a2, made.offer.offerId);
    pre.offers.acceptProposal(A, p2.request);
    pre.links.revoke(p2.link.linkId, 'local');
    expect(pre.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(true);
  });

  it('the receiver’s copy follows its pending link: active → accepted', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    a.store.setPending(offerId, link.linkId);
    const answer = b.offers.acceptProposal(A, request) as { body: { version: number } };
    a.links.applyRemoteAccept(link.linkId, answer.body.version);
    expect(a.store.get(offerId)).toMatchObject({ state: 'accepted', linkId: link.linkId });
  });

  it('forgetting the PC ends its offers on both sides', async () => {
    const { a, b, offerId } = await shared();
    b.offers.forgetHost(A);
    a.offers.forgetHost(B);
    expect(b.store.get(offerId)?.endedReason).toBe('peer-removed');
    expect(a.store.get(offerId)?.endedReason).toBe('peer-removed');
  });
});

describe('share offers — an older build reading this build’s outbox', () => {
  it('an outbox holding offer and withdrawal records loads whole: same epoch, every record kept', async () => {
    const b = makeSide(B, A);
    const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    if (!made.ok) throw new Error('create failed');
    b.offers.withdraw(made.offer.offerId);
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbox-'));
    dirs.push(outboxDir);
    const opts = { dir: outboxDir, scheduleHarden: (): void => undefined };
    const outbox = new OutboxStore(opts);
    const reply: A2aRemoteEnvelope = {
      protocol: A2A_REMOTE_PROTOCOL, linkId: 'link-1', linkVersion: 2, messageId: 'm-1', kind: 'reply', taskId: 'rt-0', text: 'hi', sentAt: new Date().toISOString(),
    };
    outbox.enqueue(A, reply);
    for (const { hostId, env } of b.outbox) outbox.enqueue(hostId, env);
    await outbox.idle();
    // The outbox file validation is unchanged by this build, so this is how an older build reads it.
    const reopened = new OutboxStore(opts);
    expect(reopened.epoch).toBe(outbox.epoch);
    expect(reopened.pending(A).map((r) => r.envelope.kind)).toEqual(['reply', 'link', 'link']);
    expect(reopened.pending(A).slice(1).map((r) => r.envelope.link?.state)).toEqual(['offer', 'offer-withdrawn']);
  });
});

describe('share offers — review fixes (consent stays bound, debts stay owed)', () => {
  it('an accepted offer whose link is gone is spent: replaying it with another pane or wider directions is refused', async () => {
    const narrowB = makeSide(B, A);
    const a = makeSide(A, B);
    const made = narrowB.offers.create({ hostId: A, end: B_PANE, allow: { outbound: false, inbound: true } });
    if (!made.ok) throw new Error('create failed');
    await flush(narrowB, a);
    const { link, request } = proposalFor(a, made.offer.offerId, A_PANE, { outbound: true, inbound: false });
    expect(narrowB.offers.acceptProposal(A, request).status).toBe(200);
    narrowB.links.revoke(link.linkId, 'local');
    // The revoked link is pruned from links.json later on.
    const realGet = narrowB.links.get.bind(narrowB.links);
    narrowB.links.get = (id: string) => (id === link.linkId ? undefined : realGet(id));
    const replay = { ...request, to: { kind: 'pane' as const, workspaceId: 'ws-secret', paneId: 'pane-9' }, allow: both };
    expect(narrowB.offers.acceptProposal(A, replay)).toEqual({ status: 409, body: { ok: false, error: 'offer-closed', reason: 'used' } });
  });

  it('a claim whose link was never made is judged like a fresh answer', async () => {
    const narrowB = makeSide(B, A);
    const a = makeSide(A, B);
    const made = narrowB.offers.create({ hostId: A, end: B_PANE, allow: { outbound: false, inbound: true } });
    if (!made.ok) throw new Error('create failed');
    await flush(narrowB, a);
    const { link, request } = proposalFor(a, made.offer.offerId, A_PANE, both);
    narrowB.store.claim(made.offer.offerId, link.linkId);
    expect(narrowB.offers.acceptProposal(A, request).status).toBe(403);
    expect(narrowB.links.list()).toEqual([]);
  });

  it('the offer is recorded before the pane is shown: a failed exposure write leaves nothing shown', () => {
    const b = makeSide(B, A);
    b.failWrites.exposure = true;
    expect(b.offers.create({ hostId: A, end: B_PANE, allow: both })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(b.store.list()).toMatchObject([{ state: 'withdrawn' }]);
    expect(b.outbox).toEqual([]);
  });

  it('a put-back whose write failed stays owed and lands later', async () => {
    const { b, offerId } = await shared();
    b.failWrites.exposure = true;
    b.offers.withdraw(offerId);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(b.store.get(offerId)?.addedExposure).toBe(true);
    b.failWrites.exposure = false;
    b.offers.reconcileExposure();
    expect(b.store.get(offerId)?.addedExposure).toBeFalsy();
    expect(new ExposureStore({ dir: b.dir, scheduleHarden: () => undefined }).isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('a pane still used by another live link stays shown until that link ends too', async () => {
    const { a, b, offerId } = await shared();
    const { link, request } = proposalFor(a, offerId);
    b.offers.acceptProposal(A, request);
    const other = crypto.randomUUID();
    b.links.receiveProposal({ linkId: other, local: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, remote: { hostId: A, kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-b' }, allow: both });
    b.links.accept(other);
    b.links.revoke(link.linkId, 'local');
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(true);
    b.links.revoke(other, 'local');
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('only a human save on this build cancels the debt: any other write still gets the pane hidden', async () => {
    const { b, offerId } = await shared();
    b.clock.now += 1_000;
    // Not the RPC: an older build writes exposure.json without knowing about offers.
    b.exposures.set(A, { workspaceIds: ['ws-api'], paneIds: { 'ws-api': ['pane-1', 'pane-2'] } });
    b.offers.withdraw(offerId);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-2')).toBe(true);
  });

  it('a workspace written in the every-pane form loses the shared pane too (dropped whole), and the debt is paid', async () => {
    const { b, offerId } = await shared();
    b.exposures.set(A, { workspaceIds: ['ws-api'] });
    b.offers.withdraw(offerId);
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(b.store.get(offerId)?.addedExposure).toBeFalsy();
  });

  it('a claimed link left proposed-in is finished only after the app’s closed-pane pass', async () => {
    let ready = true;
    const b = makeSide(B, A, { appReady: () => ready });
    const a = makeSide(A, B);
    const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    if (!made.ok) throw new Error('create failed');
    await flush(b, a);
    const { link, request } = proposalFor(a, made.offer.offerId);
    b.store.claim(made.offer.offerId, link.linkId);
    b.links.receiveProposal({ linkId: link.linkId, local: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, remote: { hostId: A, kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-a' }, allow: both });
    ready = false;
    expect(b.offers.acceptProposal(A, request)).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
    b.offers.recover();
    expect(b.links.get(link.linkId)?.state).toBe('proposed-in');
    ready = true;
    b.offers.recover();
    expect(b.links.get(link.linkId)?.state).toBe('active');
    expect(b.store.get(made.offer.offerId)?.state).toBe('accepted');
  });

  it('a claim whose link ended is spent, and its pane is hidden again', async () => {
    const { a, b, offerId } = await shared();
    const { link } = proposalFor(a, offerId);
    b.store.claim(offerId, link.linkId);
    b.links.receiveProposal({ linkId: link.linkId, local: { kind: 'pane', workspaceId: 'ws-api', paneId: 'pane-1' }, remote: { hostId: A, kind: 'pane', workspaceId: 'ws-web', paneId: 'pane-a' }, allow: both });
    b.links.revoke(link.linkId, 'local');
    expect(b.store.get(offerId)?.state).toBe('accepted');
    expect(b.exposures.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
  });

  it('two shares to one PC expiring together both put their pane back, also on disk', async () => {
    const b = makeSide(B, A);
    b.offers.create({ hostId: A, end: B_PANE, allow: both });
    b.offers.create({ hostId: A, end: { ...B_PANE, paneId: 'pane-2' }, allow: both });
    b.clock.now += A2A_OFFER_TTL_MS + 1;
    b.offers.expire();
    expect(b.store.list().every((o) => o.state === 'expired' && !o.addedExposure)).toBe(true);
    const disk = new ExposureStore({ dir: b.dir, scheduleHarden: () => undefined });
    expect(disk.isPaneExposed(A, 'ws-api', 'pane-1')).toBe(false);
    expect(disk.isPaneExposed(A, 'ws-api', 'pane-2')).toBe(false);
  });

  it('nothing is accepted before the app has published its panes since the daemon started', async () => {
    let ready = false;
    const b = makeSide(B, A, { appReady: () => ready });
    const a = makeSide(A, B);
    const made = b.offers.create({ hostId: A, end: B_PANE, allow: both });
    if (!made.ok) throw new Error('create failed');
    await flush(b, a);
    const { request } = proposalFor(a, made.offer.offerId);
    expect(b.offers.acceptProposal(A, request)).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } });
    ready = true;
    expect(b.offers.acceptProposal(A, request).status).toBe(200);
  });
});
