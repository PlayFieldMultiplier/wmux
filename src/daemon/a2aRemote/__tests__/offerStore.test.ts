import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_OFFER_TTL_MS, type A2aExposedPane } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { OFFERS_FILE, OFFERS_OPEN_PER_HOST_MAX, OfferStore, type OfferStoreOptions } from '../offerStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';
const OFFER = '33333333-3333-4333-8333-333333333333';
const LINK = '44444444-4444-4444-8444-444444444444';

let dir: string;
let fail = false;
let clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<OfferStoreOptions> = {}): OfferStore =>
  new OfferStore({ dir, now: () => clock, scheduleHarden: () => undefined, write: flakyWrite, ...o });

const pane = (n = 1): A2aExposedPane => ({
  kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: `pane-${n}`, label: `w1-${n}`, agent: 'claude', cwd: '/srv/api', gitBranch: 'main',
});
const both = { outbound: true, inbound: true };

beforeEach(() => {
  fail = false;
  clock = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-offers-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OfferStore — sharer side (out)', () => {
  it('creates an open offer that expires after the TTL and persists it', () => {
    const s = make();
    const rec = s.createOut({ hostId: HOST, end: pane(), allow: both, addedExposure: true, addedWorkspace: false });
    expect(rec).toMatchObject({ side: 'out', state: 'open', hostId: HOST, addedExposure: true });
    expect(Date.parse(rec.expiresAt) - clock).toBe(A2A_OFFER_TTL_MS);
    expect(make().get(rec.offerId)).toEqual(rec);
  });

  it('finds the live offer for a pane, and refuses more than the per-host cap', () => {
    const s = make();
    const first = s.createOut({ hostId: HOST, end: pane(1), allow: both, addedExposure: false, addedWorkspace: false });
    expect(s.findLiveOut(HOST, 'ws-api', 'pane-1')?.offerId).toBe(first.offerId);
    expect(s.findLiveOut(HOST2, 'ws-api', 'pane-1')).toBeUndefined();
    for (let n = 2; n <= OFFERS_OPEN_PER_HOST_MAX; n++) s.createOut({ hostId: HOST, end: pane(n), allow: both, addedExposure: false, addedWorkspace: false });
    expect(() => s.createOut({ hostId: HOST, end: pane(99), allow: both, addedExposure: false, addedWorkspace: false })).toThrow(/open offers/);
  });

  it('open → claimed → accepted, and a claim can be undone back to open', () => {
    const s = make();
    const { offerId } = s.createOut({ hostId: HOST, end: pane(), allow: both, addedExposure: false, addedWorkspace: false });
    expect(s.claim(offerId, LINK)).toMatchObject({ state: 'claimed', linkId: LINK });
    expect(() => s.claim(offerId, LINK)).toThrow(/not allowed/);
    expect(s.unclaim(offerId)).toMatchObject({ state: 'open' });
    expect(s.get(offerId)?.linkId).toBeUndefined();
    s.claim(offerId, LINK);
    expect(s.markAccepted(offerId)).toMatchObject({ state: 'accepted', linkId: LINK });
    expect(make().get(offerId)?.state).toBe('accepted');
  });

  it('a failed claim write rolls back; a failed end keeps the narrowing in memory', () => {
    const s = make();
    const { offerId } = s.createOut({ hostId: HOST, end: pane(), allow: both, addedExposure: false, addedWorkspace: false });
    fail = true;
    expect(() => s.claim(offerId, LINK)).toThrow(/disk full/);
    expect(s.get(offerId)?.state).toBe('open');
    expect(() => s.end(offerId, 'withdrawn', 'withdrawn')).toThrow(/disk full/);
    expect(s.get(offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'withdrawn' });
  });

  it('ends only an open offer', () => {
    const s = make();
    const { offerId } = s.createOut({ hostId: HOST, end: pane(), allow: both, addedExposure: false, addedWorkspace: false });
    s.claim(offerId, LINK);
    expect(() => s.end(offerId, 'withdrawn', 'withdrawn')).toThrow(/not allowed/);
  });

  it('expires open offers past their TTL, and ends a host’s live offers when it is forgotten', () => {
    const s = make();
    const a = s.createOut({ hostId: HOST, end: pane(1), allow: both, addedExposure: false, addedWorkspace: false });
    const b = s.createOut({ hostId: HOST2, end: pane(2), allow: both, addedExposure: false, addedWorkspace: false });
    clock += A2A_OFFER_TTL_MS - 1;
    expect(s.expire()).toEqual([]);
    clock += 2;
    expect(s.expire().map((r) => r.offerId).sort()).toEqual([a.offerId, b.offerId].sort());
    expect(s.get(a.offerId)).toMatchObject({ state: 'expired', endedReason: 'expired' });
    const c = s.createOut({ hostId: HOST, end: pane(3), allow: both, addedExposure: false, addedWorkspace: false });
    expect(s.forgetHost(HOST).map((r) => r.offerId)).toEqual([c.offerId]);
    expect(s.get(c.offerId)).toMatchObject({ state: 'withdrawn', endedReason: 'peer-removed' });
  });

  it('clears addedExposure for one host only', () => {
    const s = make();
    const a = s.createOut({ hostId: HOST, end: pane(1), allow: both, addedExposure: true, addedWorkspace: true });
    const b = s.createOut({ hostId: HOST2, end: pane(1), allow: both, addedExposure: true, addedWorkspace: false });
    s.clearAddedExposure(HOST);
    expect(s.get(a.offerId)).toMatchObject({ addedExposure: false, addedWorkspace: false });
    expect(s.get(b.offerId)?.addedExposure).toBe(true);
  });
});

describe('OfferStore — receiver side (in)', () => {
  const offerIn = (o: Partial<Parameters<OfferStore['receiveIn']>[0]> = {}) => ({
    offerId: OFFER, hostId: HOST, end: pane(), allow: { outbound: true, inbound: false }, ttlMs: A2A_OFFER_TTL_MS, ...o,
  });

  it('receives an offer once; the same payload again is a duplicate, a different one a conflict', () => {
    const s = make();
    const first = s.receiveIn(offerIn());
    expect(first).toMatchObject({ duplicate: false, rec: { side: 'in', state: 'open', offerId: OFFER } });
    expect(s.receiveIn(offerIn()).duplicate).toBe(true);
    expect(() => s.receiveIn(offerIn({ allow: both }))).toThrow(/conflict/);
    expect(() => s.receiveIn(offerIn({ hostId: HOST2 }))).toThrow(/conflict/);
  });

  it('refuses a malformed offer id and caps open offers per host', () => {
    const s = make();
    expect(() => s.receiveIn(offerIn({ offerId: 'nope' }))).toThrow(/invalid/);
    for (let n = 0; n < OFFERS_OPEN_PER_HOST_MAX; n++) {
      s.receiveIn(offerIn({ offerId: `33333333-3333-4333-8333-33333333330${n}`, end: pane(n) }));
    }
    expect(() => s.receiveIn(offerIn({ offerId: '33333333-3333-4333-8333-3333333333ff' }))).toThrow(/open offers/);
  });

  it('tracks a pending proposal, then accepts with its link', () => {
    const s = make();
    s.receiveIn(offerIn());
    expect(s.setPending(OFFER, LINK)).toMatchObject({ state: 'open', pendingLinkId: LINK });
    expect(s.setPending(OFFER, null).pendingLinkId).toBeUndefined();
    s.setPending(OFFER, LINK);
    expect(s.markAccepted(OFFER, LINK)).toMatchObject({ state: 'accepted', linkId: LINK });
    expect(s.get(OFFER)?.pendingLinkId).toBeUndefined();
  });

  it('an ended incoming offer keeps only the names, not the cwd, agent or branch', () => {
    const s = make();
    s.receiveIn(offerIn());
    const ended = s.end(OFFER, 'declined', 'declined');
    expect(ended.end).toEqual({ kind: 'pane', workspaceId: 'ws-api', workspaceName: 'API', paneId: 'pane-1', label: 'w1-1' });
  });
});

describe('OfferStore — file', () => {
  it('skips a record it does not understand instead of dropping the file', () => {
    const s = make();
    const kept = s.createOut({ hostId: HOST, end: pane(), allow: both, addedExposure: false, addedWorkspace: false });
    const file = path.join(dir, OFFERS_FILE);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { offers: Array<Record<string, unknown>> };
    raw.offers.push({ ...raw.offers[0], offerId: OFFER, state: 'some-future-state' });
    fs.writeFileSync(file, JSON.stringify(raw));
    const again = make();
    expect(again.list().map((r) => r.offerId)).toEqual([kept.offerId]);
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(false);
  });

  it('a file that is not an offers file at all is moved aside and the store starts empty', () => {
    fs.writeFileSync(path.join(dir, OFFERS_FILE), '{"v":9}');
    const s = make();
    expect(s.list()).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});
