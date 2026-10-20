import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import {
  A2A_OFFER_END_REASONS,
  A2A_OFFER_TTL_MS,
  A2A_REMOTE_RECORD_V,
  isHostId,
  type A2aExposedPane,
  type A2aLinkOfferRecordV1,
  type A2aOfferEndReason,
  type A2aOfferState,
  type HostId,
} from '../../shared/a2aRemote';
import { cleanExposedPane } from './exposedPanes';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Share offers (`offers.json`), from THIS host's perspective. An offer is the
 * sharer's consent that one paired PC may link one of its panes, once, within
 * the directions offered, before it expires. Kept apart from `links.json` so
 * an older build, which validates that file whole, never meets a state it
 * does not know.
 *
 * Transitions (anything else throws):
 *
 *   out: (none) --createOut--> open --claim--> claimed --markAccepted--> accepted
 *                                   <-unclaim--
 *        open --end / expire / forgetHost--> declined | withdrawn | expired
 *        claimed --forgetHost--> withdrawn
 *   in:  (none) --receiveIn--> open --markAccepted--> accepted
 *        open --end / expire / forgetHost--> declined | withdrawn | expired
 *
 * Write failure: creating and claiming roll memory back and throw. Ending
 * (end, expire, forgetHost) only ever narrows, so like a link revoke it keeps
 * the in-memory effect and still throws.
 *
 * Load: a record this build cannot read is skipped (and logged), never the
 * whole file, so a later format can add states without an older build losing
 * the rest. A file that is not an offers file at all is moved aside.
 */

export const OFFERS_FILE = 'offers.json';
/** Open offers per other PC, each side. */
export const OFFERS_OPEN_PER_HOST_MAX = 8;
/** Ended offers kept for display; older ones are pruned. */
export const OFFERS_TERMINAL_KEEP = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES: ReadonlySet<string> = new Set<A2aOfferState>(['open', 'claimed', 'accepted', 'declined', 'withdrawn', 'expired']);
const LIVE: ReadonlySet<A2aOfferState> = new Set<A2aOfferState>(['open', 'claimed']);
const REASONS: ReadonlySet<string> = new Set(A2A_OFFER_END_REASONS);
/** Upper bound on a received offer's lifetime, whatever the sharer asked for. */
const TTL_MAX_MS = 24 * 60 * 60 * 1000;

export interface OfferStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
  /** Test seam for offer ids (must return UUIDs). */
  mintId?: () => string;
}

export interface NewOfferOut {
  hostId: HostId;
  end: A2aExposedPane;
  allow: { outbound: boolean; inbound: boolean };
  addedExposure: boolean;
  addedWorkspace: boolean;
  ttlMs?: number;
}

export interface NewOfferIn {
  offerId: string;
  hostId: HostId;
  end: A2aExposedPane;
  /** Already flipped to THIS host's point of view. */
  allow: { outbound: boolean; inbound: boolean };
  ttlMs: number;
}

type EndState = Extract<A2aOfferState, 'declined' | 'withdrawn' | 'expired'>;

export class OfferStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly mintId: () => string;
  private readonly offers = new Map<string, A2aLinkOfferRecordV1>();
  private writable = true;

  constructor(opts: OfferStoreOptions) {
    this.filePath = path.join(opts.dir, OFFERS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.mintId = opts.mintId ?? ((): string => crypto.randomUUID());
    this.load();
  }

  // --- reads ------------------------------------------------------------------

  get(offerId: string): A2aLinkOfferRecordV1 | undefined {
    const rec = this.offers.get(offerId);
    return rec ? structuredClone(rec) : undefined;
  }

  list(): A2aLinkOfferRecordV1[] {
    return [...this.offers.values()].map((r) => structuredClone(r));
  }

  /** The open or claimed offer this PC made for one of its panes to `hostId`. */
  findLiveOut(hostId: HostId, workspaceId: string, paneId: string): A2aLinkOfferRecordV1 | undefined {
    const rec = [...this.offers.values()].find(
      (r) => r.side === 'out' && LIVE.has(r.state) && r.hostId === hostId && r.end.workspaceId === workspaceId && r.end.paneId === paneId,
    );
    return rec ? structuredClone(rec) : undefined;
  }

  /** The offer whose link is `linkId` (its own link, or the receiver's pending proposal). */
  findByLink(linkId: string): A2aLinkOfferRecordV1 | undefined {
    const rec = [...this.offers.values()].find((r) => r.linkId === linkId || r.pendingLinkId === linkId);
    return rec ? structuredClone(rec) : undefined;
  }

  // --- transitions ------------------------------------------------------------

  createOut(input: NewOfferOut): A2aLinkOfferRecordV1 {
    this.assertWritable();
    if (!isHostId(input.hostId)) throw new Error('offer: invalid hostId');
    const end = cleanEnd(input.end);
    if (!end) throw new Error('offer: invalid pane');
    const allow = cleanAllow(input.allow);
    if (!allow) throw new Error('offer: no direction allowed');
    this.assertRoom(input.hostId, 'out');
    let offerId = this.mintId();
    while (this.offers.has(offerId)) offerId = this.mintId();
    const at = this.now();
    const rec: A2aLinkOfferRecordV1 = {
      v: A2A_REMOTE_RECORD_V,
      offerId,
      side: 'out',
      hostId: input.hostId,
      end,
      allow,
      state: 'open',
      ...(input.addedExposure ? { addedExposure: true, addedWorkspace: input.addedWorkspace } : {}),
      createdAt: iso(at),
      updatedAt: iso(at),
      expiresAt: iso(at + (input.ttlMs ?? A2A_OFFER_TTL_MS)),
    };
    return this.insert(rec);
  }

  /**
   * Another PC's offer arrived. The same id with the same payload is a
   * duplicate; with anything else (or from another PC) it is refused.
   */
  receiveIn(input: NewOfferIn): { rec: A2aLinkOfferRecordV1; duplicate: boolean } {
    this.assertWritable();
    if (typeof input.offerId !== 'string' || !UUID_RE.test(input.offerId)) throw new Error('offer: invalid offerId');
    if (!isHostId(input.hostId)) throw new Error('offer: invalid hostId');
    const end = cleanEnd(input.end);
    const allow = cleanAllow(input.allow);
    if (!end || !allow) throw new Error('offer: invalid offer');
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error('offer: invalid ttl');
    const known = this.offers.get(input.offerId);
    if (known) {
      const same = known.side === 'in' && known.hostId === input.hostId && sameEnd(known.end, end) &&
        known.allow.outbound === allow.outbound && known.allow.inbound === allow.inbound;
      if (!same) throw new Error(`offer ${input.offerId}: conflict with the offer already held`);
      return { rec: structuredClone(known), duplicate: true };
    }
    this.assertRoom(input.hostId, 'in');
    const at = this.now();
    const rec: A2aLinkOfferRecordV1 = {
      v: A2A_REMOTE_RECORD_V,
      offerId: input.offerId,
      side: 'in',
      hostId: input.hostId,
      end,
      allow,
      state: 'open',
      createdAt: iso(at),
      updatedAt: iso(at),
      expiresAt: iso(at + Math.min(input.ttlMs, TTL_MAX_MS)),
    };
    return { rec: this.insert(rec), duplicate: false };
  }

  /** Sharer: a matching proposal is about to become `linkId`. Recorded before the link exists. */
  claim(offerId: string, linkId: string): A2aLinkOfferRecordV1 {
    if (!UUID_RE.test(linkId)) throw new Error('offer: invalid linkId');
    const rec = this.require(offerId, 'out', ['open'], 'claim');
    return this.commit(rec, { state: 'claimed', linkId }, true);
  }

  /** Sharer: the link was not made after all (its proposal was refused). */
  unclaim(offerId: string): A2aLinkOfferRecordV1 {
    const rec = this.require(offerId, 'out', ['claimed'], 'unclaim');
    const next = { ...rec, state: 'open' as const };
    delete next.linkId;
    return this.commitRecord(rec, next, true);
  }

  /** Sharer: claimed → accepted. Receiver: open → accepted with the link it made. */
  markAccepted(offerId: string, linkId?: string): A2aLinkOfferRecordV1 {
    const known = this.offers.get(offerId);
    if (known?.side === 'in') {
      if (!linkId || !UUID_RE.test(linkId)) throw new Error('offer: invalid linkId');
      const rec = this.require(offerId, 'in', ['open'], 'accept');
      const next: A2aLinkOfferRecordV1 = { ...rec, state: 'accepted', linkId };
      delete next.pendingLinkId;
      return this.commitRecord(rec, next, true);
    }
    const rec = this.require(offerId, 'out', ['claimed'], 'accept');
    return this.commit(rec, { state: 'accepted' }, true);
  }

  /** Receiver: our proposal for this offer is out (`linkId`), or settled without a link (null). */
  setPending(offerId: string, linkId: string | null): A2aLinkOfferRecordV1 {
    const rec = this.require(offerId, 'in', ['open'], 'setPending');
    const next = { ...rec };
    if (linkId === null) delete next.pendingLinkId;
    else {
      if (!UUID_RE.test(linkId)) throw new Error('offer: invalid linkId');
      next.pendingLinkId = linkId;
    }
    return this.commitRecord(rec, next, true);
  }

  /** End an open offer. Keeps the in-memory end on a failed write. */
  end(offerId: string, state: EndState, reason: A2aOfferEndReason): A2aLinkOfferRecordV1 {
    const rec = this.requireAny(offerId, ['open'], 'end');
    return this.commitRecord(rec, ended(rec, state, reason), false);
  }

  /**
   * Sharer: drop the exposure bookkeeping of an accepted offer whose link
   * ended and whose exposure was put back.
   */
  forgetExposure(offerId: string): void {
    const rec = this.offers.get(offerId);
    if (!rec || !rec.addedExposure) return;
    this.commitRecord(rec, { ...rec, addedExposure: false, addedWorkspace: false }, false);
  }

  /** A human edited the exposure for `hostId`: that list is the truth now, nothing is put back. */
  clearAddedExposure(hostId: HostId): void {
    const changed = [...this.offers.values()].filter((r) => r.hostId === hostId && r.addedExposure);
    if (changed.length === 0) return;
    this.assertWritable();
    for (const r of changed) this.offers.set(r.offerId, { ...r, addedExposure: false, addedWorkspace: false });
    this.persist();
  }

  /** End every open offer past its expiry. Returns the ones it ended. */
  expire(): A2aLinkOfferRecordV1[] {
    const now = this.now();
    const stale = [...this.offers.values()].filter((r) => r.state === 'open' && Date.parse(r.expiresAt) <= now);
    return this.endMany(stale, 'expired', 'expired');
  }

  /** The pairing with `hostId` ended: every live offer with it ends. Returns the ones it ended. */
  forgetHost(hostId: HostId): A2aLinkOfferRecordV1[] {
    return this.endMany([...this.offers.values()].filter((r) => r.hostId === hostId && LIVE.has(r.state)), 'withdrawn', 'peer-removed');
  }

  // --- internals --------------------------------------------------------------

  private endMany(recs: A2aLinkOfferRecordV1[], state: EndState, reason: A2aOfferEndReason): A2aLinkOfferRecordV1[] {
    if (recs.length === 0) return [];
    this.assertWritable();
    const out = recs.map((r) => ended(r, state, reason));
    for (const r of out) this.offers.set(r.offerId, r);
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] ${out.length} offer(s) ended in memory but not persisted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out.map((r) => structuredClone(r));
  }

  private assertRoom(hostId: HostId, side: 'out' | 'in'): void {
    const open = [...this.offers.values()].filter((r) => r.side === side && r.hostId === hostId && LIVE.has(r.state)).length;
    if (open >= OFFERS_OPEN_PER_HOST_MAX) throw new Error(`offer: host ${hostId} already has ${OFFERS_OPEN_PER_HOST_MAX} open offers`);
  }

  private insert(rec: A2aLinkOfferRecordV1): A2aLinkOfferRecordV1 {
    this.offers.set(rec.offerId, rec);
    try {
      this.persist();
    } catch (err) {
      this.offers.delete(rec.offerId);
      throw err;
    }
    return structuredClone(rec);
  }

  private require(offerId: string, side: 'out' | 'in', from: A2aOfferState[], op: string): A2aLinkOfferRecordV1 {
    const rec = this.requireAny(offerId, from, op);
    if (rec.side !== side) throw new Error(`offer ${offerId}: ${op} not allowed on the ${rec.side} side`);
    return rec;
  }

  private requireAny(offerId: string, from: A2aOfferState[], op: string): A2aLinkOfferRecordV1 {
    this.assertWritable();
    const rec = this.offers.get(offerId);
    if (!rec) throw new Error(`offer ${offerId}: unknown offer`);
    if (!from.includes(rec.state)) throw new Error(`offer ${offerId}: ${op} not allowed from ${rec.state}`);
    return rec;
  }

  private commit(rec: A2aLinkOfferRecordV1, patch: Partial<A2aLinkOfferRecordV1>, rollback: boolean): A2aLinkOfferRecordV1 {
    return this.commitRecord(rec, { ...rec, ...patch }, rollback);
  }

  private commitRecord(rec: A2aLinkOfferRecordV1, next: A2aLinkOfferRecordV1, rollback: boolean): A2aLinkOfferRecordV1 {
    this.assertWritable();
    const stamped = { ...next, updatedAt: iso(this.now()) };
    this.offers.set(rec.offerId, stamped);
    try {
      this.persist();
    } catch (err) {
      if (rollback) this.offers.set(rec.offerId, rec);
      else this.log('error', `[a2a-remote] offer ${rec.offerId} is ${stamped.state} in memory but could not be persisted`);
      throw err;
    }
    return structuredClone(stamped);
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(OFFERS_FILE);
  }

  private persist(): void {
    this.prune();
    this.write(this.filePath, { v: A2A_REMOTE_RECORD_V, offers: [...this.offers.values()] });
    this.scheduleHarden(this.filePath);
  }

  /**
   * Keep the newest `OFFERS_TERMINAL_KEEP` ended offers. An accepted offer
   * that still owes its exposure back (its link is live) is never pruned.
   */
  private prune(): void {
    const done = [...this.offers.values()]
      .filter((r) => !LIVE.has(r.state) && !(r.side === 'out' && r.state === 'accepted' && r.addedExposure))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const stale of done.slice(OFFERS_TERMINAL_KEEP)) this.offers.delete(stale.offerId);
  }

  private load(): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: OFFERS_FILE,
      coerce: (raw) => coerceFile(raw, this.log),
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'starting with no offers',
    });
    this.writable = writable;
    for (const rec of value ?? []) this.offers.set(rec.offerId, rec);
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cleanEnd(raw: unknown): A2aExposedPane | null {
  const end = cleanExposedPane(raw);
  return end && end.kind === 'pane' ? end : null;
}

function cleanAllow(raw: unknown): { outbound: boolean; inbound: boolean } | null {
  if (!isPlainObject(raw) || typeof raw['outbound'] !== 'boolean' || typeof raw['inbound'] !== 'boolean') return null;
  if (!raw['outbound'] && !raw['inbound']) return null;
  return { outbound: raw['outbound'], inbound: raw['inbound'] };
}

function sameEnd(a: A2aExposedPane, b: A2aExposedPane): boolean {
  return a.kind === b.kind && a.workspaceId === b.workspaceId && a.paneId === b.paneId;
}

/** The ended form. An incoming offer keeps only the names of the other PC's pane. */
function ended(rec: A2aLinkOfferRecordV1, state: EndState, reason: A2aOfferEndReason): A2aLinkOfferRecordV1 {
  const next: A2aLinkOfferRecordV1 = { ...rec, state, endedReason: reason };
  delete next.pendingLinkId;
  if (rec.side === 'in') {
    const { kind, workspaceId, workspaceName, paneId, label } = rec.end;
    next.end = { kind, workspaceId, workspaceName, ...(paneId !== undefined ? { paneId } : {}), ...(label !== undefined ? { label } : {}) };
  }
  return next;
}

/** Top-level shape decides the file; a single unreadable record is skipped and logged. */
function coerceFile(raw: unknown, log: StoreLog): A2aLinkOfferRecordV1[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['offers'])) return null;
  const out: A2aLinkOfferRecordV1[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of raw['offers']) {
    const rec = coerceRecord(r);
    if (!rec || seen.has(rec.offerId)) {
      skipped += 1;
      continue;
    }
    seen.add(rec.offerId);
    out.push(rec);
  }
  if (skipped > 0) log('warn', `[a2a-remote] ${OFFERS_FILE}: skipped ${skipped} offer record(s) this version cannot read`);
  return out;
}

function coerceRecord(r: unknown): A2aLinkOfferRecordV1 | null {
  if (!isPlainObject(r) || r['v'] !== 1) return null;
  const { offerId, side, hostId, state, endedReason, linkId, pendingLinkId, createdAt, updatedAt, expiresAt } = r;
  if (typeof offerId !== 'string' || !UUID_RE.test(offerId)) return null;
  if (side !== 'out' && side !== 'in') return null;
  if (!isHostId(hostId) || typeof state !== 'string' || !STATES.has(state)) return null;
  if (state === 'claimed' && side !== 'out') return null;
  if (!isIsoString(createdAt) || !isIsoString(updatedAt) || !isIsoString(expiresAt)) return null;
  const end = cleanEnd(r['end']);
  const allow = cleanAllow(r['allow']);
  if (!end || !allow) return null;
  const terminal = !LIVE.has(state as A2aOfferState) && state !== 'accepted';
  if (terminal ? !REASONS.has(endedReason as string) : endedReason !== undefined) return null;
  if ((state === 'claimed' || state === 'accepted') && (typeof linkId !== 'string' || !UUID_RE.test(linkId))) return null;
  if (pendingLinkId !== undefined && (typeof pendingLinkId !== 'string' || !UUID_RE.test(pendingLinkId) || side !== 'in')) return null;
  const rec: A2aLinkOfferRecordV1 = {
    v: 1,
    offerId,
    side,
    hostId,
    end,
    allow,
    state: state as A2aOfferState,
    createdAt,
    updatedAt,
    expiresAt,
  };
  if (endedReason !== undefined) rec.endedReason = endedReason as A2aOfferEndReason;
  if (typeof linkId === 'string' && UUID_RE.test(linkId)) rec.linkId = linkId;
  if (typeof pendingLinkId === 'string') rec.pendingLinkId = pendingLinkId;
  if (side === 'out' && r['addedExposure'] === true) {
    rec.addedExposure = true;
    rec.addedWorkspace = r['addedWorkspace'] === true;
  }
  return rec;
}
