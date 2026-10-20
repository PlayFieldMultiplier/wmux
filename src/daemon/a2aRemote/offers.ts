import crypto from 'node:crypto';
import {
  A2A_FEATURE_LINK_OFFER,
  A2A_OFFER_END_REASONS,
  A2A_REMOTE_PROTOCOL,
  isAllowedEndpointPair,
  type A2aExposedPane,
  type A2aLinkOfferRecordV1,
  type A2aLinkProposeRequest,
  type A2aLinkRecordV1,
  type A2aOfferEndReason,
  type A2aRemoteDeliverResponse,
  type A2aRemoteEnvelope,
  type A2aRemoteErrorCode,
  type HostId,
} from '../../shared/a2aRemote';
import type { A2aRemoteOfferCreateResult, A2aRemoteOfferEvent, A2aRemoteOfferResult } from '../../shared/rpc';
import { cleanExposedPane } from './exposedPanes';
import type { ExposureStore } from './exposureStore';
import type { NotifyLinkChange } from './linkRpc';
import { linkFromProposal, type LinkStore } from './linkStore';
import type { OfferStore } from './offerStore';
import { errMsg, isPlainObject } from './storeFile';

/**
 * Share offers, both sides (see `A2aLinkOfferRecordV1`).
 *
 * Sharer (usually the server of the pair): `create` shows the pane to that PC
 * (only that pane; nothing when it is shown already) and queues the offer as a
 * `link` envelope with `link.state: 'offer'`. That kind is on purpose: an
 * older build validates its whole outbox by message kind, and an older
 * receiver refuses an unknown link instead of failing. The other PC answers
 * with an ordinary proposal naming the offer; `acceptProposal` (B's offer path
 * of `POST /api/a2a/links`) turns a fitting one into an active link at once,
 * because the share was this human's consent for exactly that.
 *
 * Receiver: `applyInbound` keeps the offer for its human; the accept RPC
 * (`linkRpc`) sends the proposal and settles it from the answer or the link's
 * own transitions (`onLinkTransition`), in whichever order they arrive.
 *
 * Exposure a share added is put back when the offer ends without a link, and
 * when the link it made ends, unless a human edited that PC's list since
 * (`onExposureSetByHuman`) or another live link still uses the pane.
 */

export type A2aOfferEvent = A2aRemoteOfferEvent;

export interface A2aOffersDeps {
  store: OfferStore;
  links: Pick<LinkStore, 'get' | 'list' | 'receiveProposal' | 'accept' | 'discard'>;
  exposures: Pick<ExposureStore, 'addPane' | 'removePane' | 'isPaneExposed' | 'get' | 'saveUnsaved'>;
  /**
   * The app's latest publish came after it ended every share whose pane
   * closed or moved (its reconnect pass read the shares and every notice
   * landed). Until then no share is accepted. Default: always.
   */
  appReady?: () => boolean;
  /** A PC that joined this one and is not revoked (it can answer a share). */
  isPeer: (hostId: HostId) => boolean;
  /** A PC this one joined (we can call it to accept or decline its offer). */
  isJoined: (hostId: HostId) => boolean;
  /** What `hostId` advertised on its latest stream; undefined when it has not connected yet. */
  features: (hostId: HostId) => ReadonlySet<string> | undefined;
  /** Queue an envelope for `hostId`. Throws when it was not queued. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  notifyLinkChange: NotifyLinkChange;
  broadcast: (event: A2aRemoteOfferEvent) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
}

export type OfferRouteAnswer = { status: number; body: unknown };

const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);
const REASONS: ReadonlySet<string> = new Set(A2A_OFFER_END_REASONS);
/** Offers one PC may send this PC per hour; the rest are refused (and expire at the sharer). */
export const OFFERS_IN_PER_HOUR_MAX = 10;
const HOUR_MS = 60 * 60 * 1000;

export class A2aOffers {
  readonly store: OfferStore;
  private readonly deps: A2aOffersDeps;
  private readonly now: () => number;
  private readonly arrivals = new Map<HostId, number[]>();
  /** Shares whose put-back narrowed memory but not the file yet (this run). */
  private readonly putBackUnsaved = new Set<string>();

  constructor(deps: A2aOffersDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  list(): A2aLinkOfferRecordV1[] {
    this.expire();
    return this.store.list();
  }

  // --- sharer -----------------------------------------------------------------

  /** This PC's human shares one pane with `hostId`. */
  create(input: { hostId: HostId; end: unknown; allow: unknown }): A2aRemoteOfferCreateResult {
    this.expire();
    const { hostId } = input;
    if (!this.deps.isPeer(hostId)) return { ok: false, error: 'not-paired' };
    const features = this.deps.features(hostId);
    if (!features) return { ok: false, error: 'not-connected' };
    if (!features.has(A2A_FEATURE_LINK_OFFER)) return { ok: false, error: 'receiver-unsupported' };
    const end = cleanExposedPane(input.end);
    const allow = cleanAllow(input.allow);
    if (!end || end.kind !== 'pane' || !end.paneId || !allow) return { ok: false, error: 'bad-request' };
    const linked = this.deps.links.list().some(
      (l) => !TERMINAL_LINK.has(l.state) && l.remote.hostId === hostId && l.local.kind === 'pane' &&
        l.local.workspaceId === end.workspaceId && l.local.paneId === end.paneId,
    );
    if (linked) return { ok: false, error: 'already-linked' };
    const existing = this.store.findLiveOut(hostId, end.workspaceId, end.paneId);
    if (existing) return { ok: true, offer: existing, existing: true };

    // The record goes first, owning what it is about to show: a crash before
    // the exposure write leaves an offer that shows nothing and expires; a
    // crash after it leaves one that puts the pane back when it ends.
    const shown = this.deps.exposures.isPaneExposed(hostId, end.workspaceId, end.paneId);
    const workspaceListed = this.deps.exposures.get(hostId)?.workspaceIds.includes(end.workspaceId) === true;
    let offer: A2aLinkOfferRecordV1;
    try {
      offer = this.store.createOut({ hostId, end, allow, addedExposure: !shown, addedWorkspace: !shown && !workspaceListed });
    } catch (err) {
      return { ok: false, error: 'conflict', message: errMsg(err) };
    }
    if (!shown) {
      try {
        this.deps.exposures.addPane(hostId, end.workspaceId, end.paneId);
      } catch (err) {
        this.endOut(this.store.get(offer.offerId) ?? offer, 'withdrawn', 'withdrawn', false);
        return { ok: false, error: 'unavailable', message: errMsg(err) };
      }
      offer = this.store.get(offer.offerId) ?? offer;
    }
    try {
      this.deps.enqueue(hostId, this.offerEnvelope(offer));
    } catch (err) {
      this.endOut(offer, 'withdrawn', 'withdrawn', false);
      return { ok: false, error: 'unavailable', message: errMsg(err) };
    }
    this.deps.log('info', `[a2a-remote] shared pane ${end.paneId} with host ${hostId} (offer ${offer.offerId})`);
    this.changed(offer);
    return { ok: true, offer };
  }

  /** This PC's human takes a share back before the other PC accepted it. */
  withdraw(offerId: string): A2aRemoteOfferResult {
    const rec = this.store.get(offerId);
    if (!rec || rec.side !== 'out') return { ok: false, error: 'unknown-offer' };
    if (rec.state !== 'open') return { ok: false, error: 'invalid-state' };
    return { ok: true, offer: this.endOut(rec, 'withdrawn', 'withdrawn', true) };
  }

  /**
   * B's offer path of `POST /api/a2a/links` (the request names `offerId`).
   * Synchronous from the lookup to the persisted claim, so a withdraw or a
   * second proposal can never slip in between on this single thread.
   */
  acceptProposal(peerHostId: HostId, proposal: A2aLinkProposeRequest): OfferRouteAnswer {
    this.expire();
    const rec = proposal.offerId ? this.store.get(proposal.offerId) : undefined;
    // Unknown and someone else's answer the same: nothing leaks about other PCs' offers.
    if (!rec || rec.side !== 'out' || rec.hostId !== peerHostId) return refuse(403, 'forbidden');

    if (rec.state === 'claimed' || rec.state === 'accepted') {
      if (rec.linkId !== proposal.linkId) return closed('used');
      const link = this.deps.links.get(proposal.linkId);
      if (link) {
        if (link.remote.hostId !== peerHostId || !sameLocal(link, rec.end)) return closed('used');
        // A retry: finish (or answer) the link the claim made.
        return this.finish(rec, link);
      }
      // An accepted offer whose link is gone (unlinked, then pruned) is spent.
      if (rec.state === 'accepted') return closed('used');
      // Claimed, but the crash came before the link: judged like a fresh answer.
      return this.check(rec, peerHostId, proposal) ?? this.makeLink(rec, peerHostId, proposal);
    }
    if (rec.state !== 'open') return closed(rec.endedReason ?? 'expired');
    const refused = this.check(rec, peerHostId, proposal);
    if (refused) return refused;

    let claimed: A2aLinkOfferRecordV1;
    try {
      claimed = this.store.claim(rec.offerId, proposal.linkId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer ${rec.offerId} claim not stored: ${errMsg(err)}`);
      return refuse(503, 'unavailable');
    }
    return this.makeLink(claimed, peerHostId, proposal);
  }

  /** Does the proposal fit the offer: its pane, no wider directions, still shown? Null when it does. */
  private check(rec: A2aLinkOfferRecordV1, peerHostId: HostId, proposal: A2aLinkProposeRequest): OfferRouteAnswer | null {
    if (this.deps.appReady && !this.deps.appReady()) return refuse(503, 'unavailable');
    const to = proposal.to;
    if (proposal.from.kind !== 'pane' || !isAllowedEndpointPair(proposal.from.kind, to.kind) ||
      to.workspaceId !== rec.end.workspaceId || to.paneId !== rec.end.paneId) {
      return refuse(403, 'forbidden');
    }
    // The proposer's directions, seen from here: its inbound is our outbound.
    const ours = { outbound: proposal.allow.inbound, inbound: proposal.allow.outbound };
    if ((!ours.outbound && !ours.inbound) || (ours.outbound && !rec.allow.outbound) || (ours.inbound && !rec.allow.inbound)) {
      return refuse(403, 'forbidden');
    }
    // The store only: a publish already in flight may briefly drop the pane
    // from the snapshot, and a closed or moved pane has ended the offer.
    if (!this.deps.exposures.isPaneExposed(peerHostId, rec.end.workspaceId, rec.end.paneId ?? '')) return refuse(403, 'forbidden');
    return null;
  }

  /** The other PC declines our share (`POST /api/a2a/offers/:offerId/decline`). */
  decline(peerHostId: HostId, offerId: string): OfferRouteAnswer {
    const rec = this.store.get(offerId);
    if (!rec || rec.side !== 'out' || rec.hostId !== peerHostId) return refuse(403, 'forbidden');
    if (rec.state !== 'open') return { status: 200, body: { ok: true, state: rec.state } };
    const ended = this.endOut(rec, 'declined', 'declined', false);
    return { status: 200, body: { ok: true, state: ended.state } };
  }

  /** A human saved that PC's exposure list: it is the truth now, and offers it hides end. */
  onExposureSetByHuman(hostId: HostId): void {
    try {
      this.store.clearAddedExposure(hostId);
    } catch (err) {
      this.deps.log('error', `[a2a-remote] offers for ${hostId}: exposure bookkeeping not stored: ${errMsg(err)}`);
    }
    for (const rec of this.store.list()) {
      if (rec.side !== 'out' || rec.state !== 'open' || rec.hostId !== hostId) continue;
      if (!this.deps.exposures.isPaneExposed(hostId, rec.end.workspaceId, rec.end.paneId ?? '')) this.endOut(rec, 'withdrawn', 'exposure-revoked', true);
    }
  }

  /** A pane or workspace of this PC closed or moved: its open shares end. */
  onPaneGone(gone: { workspaceId: string; paneId?: string; reason: 'pane-closed' | 'pane-moved' | 'workspace-gone' }): void {
    for (const rec of this.store.list()) {
      if (rec.side !== 'out' || rec.state !== 'open' || rec.end.workspaceId !== gone.workspaceId) continue;
      if (gone.reason !== 'workspace-gone' && rec.end.paneId !== gone.paneId) continue;
      this.endOut(rec, 'withdrawn', gone.reason, true);
    }
  }

  /** `hostId`'s stream came up with these features: without offers, its open shares end. */
  onPeerFeatures(hostId: HostId, features: readonly string[]): void {
    if (features.includes(A2A_FEATURE_LINK_OFFER)) return;
    for (const rec of this.store.list()) {
      if (rec.side === 'out' && rec.state === 'open' && rec.hostId === hostId) this.endOut(rec, 'withdrawn', 'receiver-unsupported', false);
    }
  }

  /** The other PC refused an envelope for good. An offer it cannot read means an older build. */
  onRefused(hostId: HostId, envelope: A2aRemoteEnvelope, code: A2aRemoteErrorCode): void {
    if (envelope.kind !== 'link' || envelope.link?.state !== 'offer') return;
    if (code !== 'unknown-link' && code !== 'bad-request') return;
    const rec = this.store.get(envelope.linkId);
    if (rec?.side === 'out' && rec.state === 'open' && rec.hostId === hostId) this.endOut(rec, 'withdrawn', 'receiver-unsupported', false);
  }

  // --- receiver ---------------------------------------------------------------

  /** One offer envelope (`link.state` `offer` / `offer-withdrawn`) from an authenticated peer. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    const state = env.link?.state;
    if (state === 'offer-withdrawn') return this.inboundWithdrawn(env, peer.hostId);
    // Only a PC we joined: accepting means calling it, which needs its credential.
    if (!this.deps.isJoined(peer.hostId)) return fail('forbidden', 'offers are taken only from a PC this PC joined');
    const payload = asRecord(env.offer);
    const end = payload ? cleanExposedPane(payload['end']) : null;
    const allow = payload ? cleanAllow(payload['allow']) : null;
    const ttlMs = payload?.['ttlMs'];
    if (!end || end.kind !== 'pane' || !allow || typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs <= 0) return fail('bad-request');
    const known = this.store.get(env.linkId);
    if (!known && !this.admit(peer.hostId)) return fail('forbidden', 'too many offers from that PC');
    try {
      const { rec, duplicate } = this.store.receiveIn({
        offerId: env.linkId,
        hostId: peer.hostId,
        end,
        // The sharer's outbound is our inbound.
        allow: { outbound: allow.inbound, inbound: allow.outbound },
        ttlMs,
      });
      if (!duplicate) this.changed(rec);
      return { ok: true, duplicate };
    } catch (err) {
      const msg = errMsg(err);
      if (msg.includes('conflict')) return fail('conflict', msg);
      // A refusal of the offer itself (shape, cap) is for good; anything else is
      // this PC's store failing, so the stream event is not acked and comes again.
      if (msg.startsWith('offer:')) return fail('forbidden', msg);
      // Not stored, so the redelivery is not a new offer to count again.
      if (!known) this.unadmit(peer.hostId);
      return fail('unavailable', msg);
    }
  }

  // --- both -------------------------------------------------------------------

  /** `LinkStore.onTransition`: settle the offer a link belongs to. */
  onLinkTransition(link: A2aLinkRecordV1): void {
    const rec = this.store.findByLink(link.linkId);
    if (!rec) {
      // A link no share made can still be the last user of a shared pane.
      if (TERMINAL_LINK.has(link.state)) this.reconcileExposure();
      return;
    }
    if (rec.side === 'out') {
      if (!TERMINAL_LINK.has(link.state)) return;
      // A claim whose link ended before it was marked accepted is spent too.
      if (rec.state === 'claimed') {
        try {
          this.changed(this.store.markAccepted(rec.offerId));
        } catch (err) {
          this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: spent, not stored yet: ${errMsg(err)}`);
        }
      }
      // The link a share made ended: the pane it showed is hidden again (and
      // any other share's pane this link was the last user of).
      this.reconcileExposure();
      return;
    }
    if (rec.state !== 'open' || rec.pendingLinkId !== link.linkId) return;
    try {
      const next = link.state === 'active'
        ? this.store.markAccepted(rec.offerId, link.linkId)
        : TERMINAL_LINK.has(link.state) ? this.store.end(rec.offerId, 'withdrawn', 'withdrawn') : null;
      if (next) this.changed(next);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer ${rec.offerId} did not follow link ${link.linkId}: ${errMsg(err)}`);
    }
  }

  /** The pairing with `hostId` ended. */
  forgetHost(hostId: HostId): void {
    for (const rec of this.store.forgetHost(hostId)) this.changed(rec);
  }

  /** End offers past their expiry (and put back what the sharer's ones showed). */
  expire(): void {
    let ended: A2aLinkOfferRecordV1[];
    try {
      ended = this.store.expire();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer expiry failed: ${errMsg(err)}`);
      return;
    }
    for (const rec of ended) {
      if (rec.side === 'out') {
        this.putBackExposure(this.store.get(rec.offerId) ?? rec);
        this.tell(rec, 'expired');
      }
      this.changed(rec);
    }
  }

  /**
   * Startup, and the minute upkeep: a claimed offer is settled by what `links.json` holds — active:
   * accepted; still proposed-in: accept it now (the claim bound the consent);
   * missing: the crash came first, it is open again.
   */
  recover(): void {
    for (const rec of this.store.list()) {
      if (rec.side !== 'out' || rec.state !== 'claimed' || !rec.linkId) continue;
      const link = this.deps.links.get(rec.linkId);
      try {
        if (!link || link.remote.hostId !== rec.hostId) this.changed(this.store.unclaim(rec.offerId));
        // A proposed-in link waits for the app's closed-pane pass (finish answers 503 till then).
        else if (link.state === 'proposed-in' || link.state === 'active') this.finish(rec, link);
        // The link was made and has ended since: the offer is spent, and owes its exposure back.
        else this.changed(this.store.markAccepted(rec.offerId));
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] offer ${rec.offerId} not recovered: ${errMsg(err)}`);
      }
    }
    this.expire();
    this.reconcileExposure();
  }

  /**
   * Put back every share's exposure that is due and not yet back: the share
   * ended without a link, or its link ended. A put-back that could not land
   * (a write failed, a live link still used the pane) is tried again here.
   */
  reconcileExposure(): void {
    for (const { offerId } of this.store.list()) {
      // Re-read: putting one back can change the next one's record.
      const rec = this.store.get(offerId);
      if (!rec || rec.side !== 'out' || !rec.addedExposure) continue;
      if (rec.state === 'open' || rec.state === 'claimed') continue;
      if (rec.state === 'accepted' && rec.linkId) {
        const link = this.deps.links.get(rec.linkId);
        if (link && !TERMINAL_LINK.has(link.state)) continue;
      }
      this.putBackExposure(rec);
    }
  }

  // --- internals --------------------------------------------------------------

  private makeLink(claimed: A2aLinkOfferRecordV1, peerHostId: HostId, proposal: A2aLinkProposeRequest): OfferRouteAnswer {
    let link: A2aLinkRecordV1;
    try {
      link = this.deps.links.receiveProposal(linkFromProposal(peerHostId, proposal));
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer ${claimed.offerId}: link not made: ${errMsg(err)}`);
      try {
        this.store.unclaim(claimed.offerId);
      } catch (unclaimErr) {
        this.deps.log('error', `[a2a-remote] offer ${claimed.offerId} left claimed: ${errMsg(unclaimErr)}`);
      }
      return refuse(409, 'conflict');
    }
    return this.finish(claimed, link);
  }

  /** Accept the claimed offer's link (when still proposed-in) and answer its state. */
  private finish(rec: A2aLinkOfferRecordV1, link: A2aLinkRecordV1): OfferRouteAnswer {
    let current = link;
    if (current.state === 'proposed-in') {
      // Not before the app's closed-pane pass: the pane may be gone.
      if (this.deps.appReady && !this.deps.appReady()) return refuse(503, 'unavailable');
      try {
        current = this.deps.links.accept(current.linkId);
      } catch (err) {
        // The link stands, still acceptable by this PC's human; a retry or the next start finishes it.
        this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: accept not stored: ${errMsg(err)}`);
        return { status: 200, body: { linkId: current.linkId, state: 'proposed-in', offerClaimed: true } };
      }
      this.deps.notifyLinkChange(current.remote.hostId, current.linkId, 'active', current.version);
    }
    if (current.state !== 'active') return closed('used');
    if (rec.state === 'claimed') {
      try {
        this.changed(this.store.markAccepted(rec.offerId));
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: accepted, not stored yet: ${errMsg(err)}`);
      }
    }
    return { status: 200, body: { linkId: current.linkId, state: 'active', version: current.version } };
  }

  private inboundWithdrawn(env: A2aRemoteEnvelope, hostId: HostId): A2aRemoteDeliverResponse {
    const rec = this.store.get(env.linkId);
    if (!rec || rec.side !== 'in' || rec.hostId !== hostId || rec.state !== 'open') return { ok: true, duplicate: true };
    const raw = asRecord(env.offer)?.['reason'];
    const reason = typeof raw === 'string' && REASONS.has(raw) ? (raw as A2aOfferEndReason) : 'withdrawn';
    let ended: A2aLinkOfferRecordV1;
    try {
      ended = this.store.end(rec.offerId, reason === 'expired' ? 'expired' : 'withdrawn', reason);
    } catch (err) {
      ended = this.store.get(rec.offerId) ?? rec;
      if (ended.state === 'open') return fail('unavailable', errMsg(err));
    }
    // A proposal of ours that the sharer never turned into a link goes too.
    if (rec.pendingLinkId && this.deps.links.get(rec.pendingLinkId)?.state === 'proposed-out') {
      try {
        this.deps.links.discard(rec.pendingLinkId);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: pending proposal not dropped: ${errMsg(err)}`);
      }
    }
    this.changed(ended);
    return { ok: true, duplicate: false };
  }

  /** End our open offer, put back what it showed, and (optionally) tell the receiver. */
  private endOut(rec: A2aLinkOfferRecordV1, state: 'declined' | 'withdrawn' | 'expired', reason: A2aOfferEndReason, tell: boolean): A2aLinkOfferRecordV1 {
    let ended: A2aLinkOfferRecordV1;
    try {
      ended = this.store.end(rec.offerId, state, reason);
    } catch (err) {
      // Ending keeps its in-memory effect on a failed write.
      this.deps.log('error', `[a2a-remote] offer ${rec.offerId} end not persisted: ${errMsg(err)}`);
      ended = this.store.get(rec.offerId) ?? rec;
    }
    this.putBackExposure(ended);
    if (tell) this.tell(ended, reason);
    this.changed(ended);
    return ended;
  }

  /** Queue the receiver's notice that the offer is gone (best effort; it also expires there). */
  private tell(rec: A2aLinkOfferRecordV1, reason: A2aOfferEndReason): void {
    try {
      this.deps.enqueue(rec.hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: rec.offerId,
        linkVersion: 0,
        messageId: crypto.randomUUID(),
        kind: 'link',
        link: { state: 'offer-withdrawn', version: 0 },
        offer: { reason },
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: withdrawal not queued: ${errMsg(err)}`);
    }
  }

  /**
   * Hide again what a share showed. Not while a live link to that PC still
   * uses the pane (the debt is kept and paid when that link ends). Only a
   * human's save of that PC's list on this build (`onExposureSetByHuman`)
   * cancels the debt; anything else gets the narrower list. The debt is
   * dropped only once the put-back is on disk.
   */
  private putBackExposure(rec: A2aLinkOfferRecordV1): void {
    if (rec.side !== 'out' || !rec.addedExposure || !rec.end.paneId) return;
    const inUse = this.deps.links.list().some(
      (l) => !TERMINAL_LINK.has(l.state) && l.linkId !== rec.linkId && l.remote.hostId === rec.hostId &&
        l.local.kind === 'pane' && l.local.workspaceId === rec.end.workspaceId && l.local.paneId === rec.end.paneId,
    );
    if (inUse) return;
    if (this.putBackUnsaved.has(rec.offerId)) {
      // Hidden in memory already; the debt is paid once the file says so too.
      try {
        this.deps.exposures.saveUnsaved();
      } catch {
        return;
      }
      this.putBackUnsaved.delete(rec.offerId);
      this.settlePutBack(rec);
      return;
    }
    if (!this.unexpose(rec.hostId, rec.end, rec.addedWorkspace === true)) {
      this.putBackUnsaved.add(rec.offerId);
      return;
    }
    this.settlePutBack(rec);
  }

  private settlePutBack(rec: A2aLinkOfferRecordV1): void {
    try {
      this.store.forgetExposure(rec.offerId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] offer ${rec.offerId}: exposure bookkeeping not stored: ${errMsg(err)}`);
    }
  }

  /** False when the write failed (the pane is hidden in memory; on disk it is put back on the next start). */
  private unexpose(hostId: HostId, end: A2aExposedPane, dropWorkspace: boolean): boolean {
    try {
      this.deps.exposures.removePane(hostId, end.workspaceId, end.paneId ?? '', dropWorkspace);
      return true;
    } catch (err) {
      this.deps.log('error', `[a2a-remote] pane ${end.paneId} hidden from ${hostId} in memory only: ${errMsg(err)}`);
      return false;
    }
  }


  private offerEnvelope(rec: A2aLinkOfferRecordV1): A2aRemoteEnvelope {
    return {
      protocol: A2A_REMOTE_PROTOCOL,
      linkId: rec.offerId,
      linkVersion: 0,
      messageId: crypto.randomUUID(),
      kind: 'link',
      link: { state: 'offer', version: 0 },
      offer: { end: rec.end, allow: rec.allow, ttlMs: Math.max(1, Date.parse(rec.expiresAt) - this.now()) },
      sentAt: new Date(this.now()).toISOString(),
    };
  }

  /** At most `OFFERS_IN_PER_HOUR_MAX` new offers per PC per hour. */
  private admit(hostId: HostId): boolean {
    const now = this.now();
    const recent = (this.arrivals.get(hostId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= OFFERS_IN_PER_HOUR_MAX) {
      this.arrivals.set(hostId, recent);
      return false;
    }
    recent.push(now);
    this.arrivals.set(hostId, recent);
    return true;
  }

  /** Take back the arrival `admit` just counted. */
  private unadmit(hostId: HostId): void {
    this.arrivals.get(hostId)?.pop();
  }

  /** Tell the app an offer changed (also used by the receiver's accept / decline RPCs). */
  announce(rec: A2aLinkOfferRecordV1): void {
    this.changed(rec);
  }

  private changed(rec: A2aLinkOfferRecordV1): void {
    this.deps.broadcast({
      type: 'a2a.remote.offer.changed',
      offerId: rec.offerId,
      side: rec.side,
      state: rec.state,
      ...(rec.linkId && rec.state === 'accepted' ? { linkId: rec.linkId } : {}),
    });
  }
}

/** Remote input, read field by field. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return isPlainObject(v) ? v : null;
}

function cleanAllow(raw: unknown): { outbound: boolean; inbound: boolean } | null {
  if (!isPlainObject(raw) || typeof raw['outbound'] !== 'boolean' || typeof raw['inbound'] !== 'boolean') return null;
  if (!raw['outbound'] && !raw['inbound']) return null;
  return { outbound: raw['outbound'], inbound: raw['inbound'] };
}

function sameLocal(link: A2aLinkRecordV1, end: A2aExposedPane): boolean {
  return link.local.kind === 'pane' && link.local.workspaceId === end.workspaceId && link.local.paneId === end.paneId;
}

function refuse(status: number, error: A2aRemoteErrorCode): OfferRouteAnswer {
  return { status, body: { ok: false, error } };
}

function closed(reason: A2aOfferEndReason): OfferRouteAnswer {
  return { status: 409, body: { ok: false, error: 'offer-closed', reason } };
}

function fail(error: A2aRemoteErrorCode, message?: string): A2aRemoteDeliverResponse {
  return { ok: false, error, ...(message ? { message } : {}) };
}
