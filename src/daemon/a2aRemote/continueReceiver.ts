import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_CONTINUE_LINK_STATES,
  CONTINUE_BYTES_MAX,
  CONTINUE_FILES_MAX,
  continueAnswerFor,
  continueClaimable,
  continueClockOk,
  isContinueAgent,
  parseContinueManifest,
  parseContinueRequest,
  parseContinueResult,
  parseContinueStatusQuery,
  type A2aContinueCode,
  type A2aContinueIncomingState,
  type A2aContinueLinkState,
  type A2aContinueManifestV1,
  type A2aContinuePermissionMode,
  type A2aContinueRequestV1,
} from '../../shared/a2aContinue';
import { spawnHostAllowed } from '../../shared/a2aSpawn';
import type { ContinuePolicyStore } from './continuePolicyStore';
import { sameContinueBody, type ContinueRequestRecordV1, type ContinueRequestStore } from './continueRequestStore';
import { spawnChecks, type SpawnChecks } from './spawnChecks';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import { errMsg } from './storeFile';

/**
 * Continuing a conversation from another PC, the receiving side (this PC is
 * B; see `shared/a2aContinue.ts`). Every step goes back to A as a
 * `continue-result` envelope through this PC's own outbox, and each record
 * remembers the answer last queued, so one that never left is sent again on
 * recovery (and on each sweep).
 *
 * Receiving a request, in this order, so a PC that may not send one learns
 * nothing else (these refusals are not stored):
 *   1. this PC takes conversations (continue policy on), from that PC, of
 *      that agent (the remote-spawn policy)            else `not-allowed`
 *   -- a request already here is answered from its record; the same id with
 *      another body is a `conflict`
 *   2. B's clock window (`continueClockOk`)            else `expired`
 *   3. no other open request carries that conversation, and room for one
 *      more of that PC's                                else `busy`
 *   -- stored pending; then, one request at a time:
 *   4. its estimate within this PC's caps               else `too-large`
 *   5. no pane here runs that conversation              else `busy`
 *   6. exactly one spawn root has that origin           else `repo-not-found` / `repo-ambiguous`
 *   7. room on the disk for the estimate                else `no-space`
 *   8. the policy and the expiry, read again after those waits
 *   9. a card can be shown                              else `not-allowed`
 *      → `awaiting` (`waiting-for-approval`); the card answers `decide`.
 *
 * Then: approved → `ready`; the manifest (`receiving`), checked against the
 * request's commit, the caps and the disk; `received` once PR2b's route has
 * every file in staging; `claim` → `starting`, only while
 * `continueClaimable`; `started` / `failed`. An unclaimed request past its
 * expiry ends `expired` on the sweep. A claimed one is never started again,
 * nor failed by a restart: whether its pane started is not known here, and a
 * `failed` would let A resume its own copy beside it.
 */

/** The same answer to the same request goes out at most once in this window (a resend, a status query). */
export const CONTINUE_RESEND_COALESCE_MS = 60_000;
/** Recent answers remembered for coalescing. */
const ANSWERED_RECENTLY_MAX = 1000;
/** Open states before main claims a request: the sweep expires these. */
const UNCLAIMED: readonly A2aContinueIncomingState[] = ['pending', 'awaiting', 'ready', 'receiving', 'received'];

export interface ContinueReceiverDeps {
  policy: Pick<ContinuePolicyStore, 'get'>;
  /** The PCs, folders and agents this PC takes work from. */
  spawnPolicy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<ContinueRequestStore, 'get' | 'inState' | 'unsent' | 'receive' | 'advance' | 'decide' | 'markSent' | 'prune'>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** The origin of the repository at a spawn root, as originUrlRepoKey writes it; null without one. */
  originKeyOf: (rootPath: string) => Promise<string | null>;
  /** Free bytes where a received conversation is written. */
  freeBytes: () => Promise<number>;
  /** A pane on this PC runs the conversation `sessionId`. */
  sessionLive: (sessionId: string) => boolean;
  /** The approval card can be shown. Absent: no card, so every request ends `not-allowed` after its checks. */
  cardAvailable?: () => boolean;
  /** This PC's caps, never above the contract's (default: the contract's). */
  limits?: { bytes: number; files: number };
  now?: () => number;
  /** Test seams. */
  checks?: SpawnChecks;
  resendCoalesceMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** What main needs to start a claimed conversation. */
export interface ContinueClaim {
  hostId: HostId;
  request: A2aContinueRequestV1;
  manifest: A2aContinueManifestV1;
  rootId: string;
  rootPath: string;
  permissionMode: A2aContinuePermissionMode;
}

export type ContinueStepResult = { ok: true } | { ok: false; error: string };
export type ContinueClaimResult = { ok: true; claim: ContinueClaim } | { ok: false; error: string };

export function isContinueEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: A2aContinueLinkState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s !== undefined && (A2A_CONTINUE_LINK_STATES as readonly string[]).includes(s);
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const DUPLICATE: A2aRemoteDeliverResponse = { ok: true, duplicate: true };
const UNAVAILABLE: A2aRemoteDeliverResponse = { ok: false, error: 'unavailable' };
const BAD: A2aRemoteDeliverResponse = { ok: false, error: 'bad-request' };
const CONFLICT: A2aRemoteDeliverResponse = { ok: false, error: 'conflict' };
const NOT_STORED: { ok: false; error: string } = { ok: false, error: 'the answer could not be stored' };

export class A2aContinueReceiver {
  private readonly deps: ContinueReceiverDeps;
  private readonly now: () => number;
  private readonly checks: SpawnChecks;
  private readonly limits: { bytes: number; files: number };
  private readonly coalesceMs: number;
  /** Makes every result's message id new, across restarts too. */
  private readonly boot: string;
  private sends = 0;
  private stopped = false;
  /** When each answer (host:continueId:code) was last sent. */
  private readonly answeredAt = new Map<string, number>();
  /** Checks and manifests, one at a time: their disk and git checks share one bounded gate. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ContinueReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.checks = deps.checks ?? spawnChecks;
    this.limits = {
      bytes: Math.min(deps.limits?.bytes ?? CONTINUE_BYTES_MAX, CONTINUE_BYTES_MAX),
      files: Math.min(deps.limits?.files ?? CONTINUE_FILES_MAX, CONTINUE_FILES_MAX),
    };
    this.coalesceMs = deps.resendCoalesceMs ?? CONTINUE_RESEND_COALESCE_MS;
    this.boot = this.now().toString(36);
  }

  /** One continue envelope from an authenticated peer: `peer.hostId` is the asker, never a field of the body. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse | Promise<A2aRemoteDeliverResponse> {
    if (env.linkVersion !== 0) return BAD;
    switch (env.link?.state) {
      case 'continue': {
        const req = parseContinueRequest(env.continue);
        return req && req.continueId === env.linkId ? this.receive(peer.hostId, req, env.sentAt) : BAD;
      }
      case 'continue-manifest': {
        const manifest = parseContinueManifest(env.continueManifest);
        return manifest && manifest.continueId === env.linkId ? this.serial(() => this.takeManifest(peer.hostId, manifest)) : BAD;
      }
      case 'continue-status': {
        const query = parseContinueStatusQuery(env.continueStatus);
        return query && query.continueId === env.linkId ? this.answer(peer.hostId, query.continueId) : BAD;
      }
      case 'continue-result': {
        // An answer to a request this PC sent: the sending side is not built yet, so it is taken and dropped.
        const result = parseContinueResult(env.continueResult);
        return result && result.continueId === env.linkId ? OK : BAD;
      }
      default:
        return BAD;
    }
  }

  /** After a restart: check what is pending, send what was owed, expire what ran out. */
  recover(): void {
    for (const rec of this.deps.requests.inState('pending')) {
      const { hostId } = rec;
      const { continueId } = rec.request;
      void this.serial(() => this.check(hostId, continueId));
    }
    this.sweep();
  }

  /** Unclaimed requests past their expiry end `expired`; owed answers go again; old decided records go. */
  sweep(): void {
    for (const state of UNCLAIMED) {
      for (const rec of this.deps.requests.inState(state)) {
        if (this.now() > Date.parse(rec.request.expiresAt)) this.finish(rec.hostId, rec.request.continueId, 'expired');
      }
    }
    for (const rec of this.deps.requests.unsent()) this.sendOwed(rec);
    try {
      this.deps.requests.prune();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue requests not pruned: ${errMsg(err)}`);
    }
  }

  /** The card's answer: `once` approves this request, `deny` declines it. A continue card never offers more. */
  decide(hostId: HostId, continueId: string, verdict: unknown): ContinueStepResult {
    if (verdict !== 'once' && verdict !== 'deny') return { ok: false, error: 'a continue card answers once or deny' };
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'awaiting') return { ok: false, error: 'this request is not waiting for its card' };
    let code: A2aContinueCode | undefined;
    if (verdict === 'deny') code = 'declined';
    else if (this.expired(rec)) code = 'expired';
    else if (!this.allowed(hostId, rec.request)) code = 'not-allowed';
    else if (this.deps.sessionLive(rec.request.sessionId)) code = 'busy';
    if (code) {
      if (!this.finish(hostId, continueId, code)) return NOT_STORED;
      return code === 'declined' ? { ok: true } : { ok: false, error: code };
    }
    return this.step(hostId, continueId, ['awaiting'], 'ready') ? { ok: true } : NOT_STORED;
  }

  /** Every file of the manifest is in staging and checked: the conversation is this PC's now. */
  received(hostId: HostId, continueId: string): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'receiving') return { ok: false, error: 'this request is not receiving' };
    // Bytes that came after the expiry are never taken: A resumes its own copy on `expired`.
    if (this.expired(rec)) return this.finish(hostId, continueId, 'expired') ? { ok: false, error: 'expired' } : NOT_STORED;
    return this.step(hostId, continueId, ['receiving'], 'received') ? { ok: true } : NOT_STORED;
  }

  /** The bytes could not be received or checked. */
  receiveFailed(hostId: HostId, continueId: string): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'receiving') return { ok: false, error: 'this request is not receiving' };
    return this.finish(hostId, continueId, 'failed') ? { ok: true } : NOT_STORED;
  }

  /**
   * Main takes a received request to start it: only while `continueClaimable`
   * (never after its expiry, never twice), and only while the policy still
   * allows that PC and lists the root it matched. A refusal ends the request.
   */
  claim(hostId: HostId, continueId: string): ContinueClaimResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'received' || !rec.manifest || !rec.rootId) return { ok: false, error: 'this request is not received, or is already starting' };
    if (!continueClaimable(rec, this.now())) return this.finish(hostId, continueId, 'expired') ? { ok: false, error: 'expired' } : NOT_STORED;
    const root = this.deps.spawnPolicy.get().roots.find((r) => r.id === rec.rootId);
    if (!root || !this.allowed(hostId, rec.request)) return this.finish(hostId, continueId, 'not-allowed') ? { ok: false, error: 'not-allowed' } : NOT_STORED;
    if (!this.step(hostId, continueId, ['received'], 'starting')) return NOT_STORED;
    return {
      ok: true,
      claim: {
        hostId,
        request: rec.request,
        manifest: rec.manifest,
        rootId: root.id,
        rootPath: root.path,
        permissionMode: this.deps.policy.get().in.permissionMode,
      },
    };
  }

  /** Main started the claimed conversation in a pane. */
  started(hostId: HostId, continueId: string): ContinueStepResult {
    return this.endStart(hostId, continueId, 'started');
  }

  /** Main could not start the claimed conversation. */
  failed(hostId: HostId, continueId: string): ContinueStepResult {
    return this.endStart(hostId, continueId, 'failed');
  }

  /** Settle every check and manifest in flight (tests). */
  async idle(): Promise<void> {
    let q: Promise<unknown>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  stop(): void {
    this.stopped = true;
  }

  private endStart(hostId: HostId, continueId: string, code: 'started' | 'failed'): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'starting') return { ok: false, error: 'this request is not starting' };
    return this.finish(hostId, continueId, code) ? { ok: true } : NOT_STORED;
  }

  private receive(hostId: HostId, req: A2aContinueRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    if (!this.allowed(hostId, req)) return this.refuse(hostId, req.continueId, 'not-allowed');
    // A request already here is answered from its record, whatever the clock says now.
    const known = this.deps.requests.get(hostId, req.continueId);
    if (known) return sameContinueBody(known.request, req) ? this.answer(hostId, req.continueId, true) : CONFLICT;
    if (!continueClockOk(sentAt, req.expiresAt, this.now())) return this.refuse(hostId, req.continueId, 'expired');
    let got: ReturnType<ContinueReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue request from ${hostId} not stored: ${errMsg(err)}`);
      return UNAVAILABLE;
    }
    if (got.kind === 'conflict') return CONFLICT;
    if (got.kind === 'duplicate') return this.answer(hostId, req.continueId, true);
    if (got.kind === 'busy' || got.kind === 'full') return this.refuse(hostId, req.continueId, 'busy');
    this.deps.log('info', `[a2a-remote] continue ${req.continueId} from ${hostId}: received (agent ${req.agent})`);
    void this.serial(() => this.check(hostId, req.continueId));
    return OK;
  }

  /** The checks of a pending request, then its card or its refusal. */
  private async check(hostId: HostId, continueId: string): Promise<void> {
    const rec = this.deps.requests.get(hostId, continueId);
    if (this.stopped || !rec || rec.state !== 'pending') return;
    let outcome: A2aContinueCode | { rootId: string };
    try {
      outcome = await this.evaluate(rec);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: a check did not finish: ${errMsg(err)}`);
      outcome = 'failed';
    }
    // The policy may have changed meanwhile: a PC no longer allowed learns nothing more, not even its repository codes.
    if (!this.allowed(hostId, rec.request)) outcome = 'not-allowed';
    if (this.stopped || this.deps.requests.get(hostId, continueId)?.state !== 'pending') return;
    if (typeof outcome === 'string') this.finish(hostId, continueId, outcome);
    else this.step(hostId, continueId, ['pending'], 'awaiting', { rootId: outcome.rootId });
  }

  private async evaluate(rec: ContinueRequestRecordV1): Promise<A2aContinueCode | { rootId: string }> {
    const req = rec.request;
    if (this.expired(rec)) return 'expired';
    if (req.estimate.bytes > this.limits.bytes || req.estimate.files > this.limits.files) return 'too-large';
    if (this.deps.sessionLive(req.sessionId)) return 'busy';
    const matched: string[] = [];
    for (const root of this.deps.spawnPolicy.get().roots) {
      // eslint-disable-next-line no-await-in-loop -- one git read at a time, through the bounded gate
      if ((await this.checks.run(() => this.deps.originKeyOf(root.path))) === req.repo.origin) matched.push(root.id);
    }
    if (matched.length === 0) return 'repo-not-found';
    if (matched.length > 1) return 'repo-ambiguous';
    if ((await this.checks.run(() => this.deps.freeBytes())) < req.estimate.bytes) return 'no-space';
    if (this.expired(rec)) return 'expired';
    if (!this.deps.cardAvailable?.()) return 'not-allowed';
    return { rootId: matched[0] };
  }

  /**
   * The manifest A took once its agent stopped, only for a request that is
   * `ready`. A resend of the one taken is a duplicate, another one a
   * conflict; for a request not waiting for one, A hears where it is.
   */
  private async takeManifest(hostId: HostId, manifest: A2aContinueManifestV1): Promise<A2aRemoteDeliverResponse> {
    const rec = this.deps.requests.get(hostId, manifest.continueId);
    if (!rec || rec.state !== 'ready') {
      if (rec?.manifest) return sameContinueBody(rec.manifest, manifest) ? DUPLICATE : CONFLICT;
      return this.answer(hostId, manifest.continueId);
    }
    const bytes = manifest.files.reduce((n, f) => n + f.bytes, manifest.transcript.bytes);
    let code: A2aContinueCode | undefined;
    // A's checkout moved on while B decided: what it took is of another commit.
    if (manifest.head !== rec.request.repo.head) code = 'diverged';
    else if (!this.allowed(hostId, rec.request)) code = 'not-allowed';
    else if (this.expired(rec)) code = 'expired';
    else if (bytes > this.limits.bytes || manifest.files.length > this.limits.files) code = 'too-large';
    else {
      try {
        if ((await this.checks.run(() => this.deps.freeBytes())) < bytes) code = 'no-space';
      } catch (err) {
        // Not settled: A sends the manifest again (or the request expires).
        this.deps.log('warn', `[a2a-remote] continue ${manifest.continueId} from ${hostId}: free space not read: ${errMsg(err)}`);
        return UNAVAILABLE;
      }
    }
    if (code) return this.finish(hostId, manifest.continueId, code) ? OK : UNAVAILABLE;
    return this.step(hostId, manifest.continueId, ['ready'], 'receiving', { manifest }) ? OK : UNAVAILABLE;
  }

  /** This PC takes conversations, from `hostId`, of the request's agent. */
  private allowed(hostId: HostId, req: A2aContinueRequestV1): boolean {
    const spawn = this.deps.spawnPolicy.get();
    return this.deps.policy.get().in.enabled && spawnHostAllowed(spawn, hostId) && isContinueAgent(req.agent) && spawn.agents.includes(req.agent);
  }

  private expired(rec: ContinueRequestRecordV1): boolean {
    return !(this.now() <= Date.parse(rec.request.expiresAt));
  }

  /** Move a request on and send its answer when that changed. False when it was not in `from` or not stored. */
  private step(
    hostId: HostId,
    continueId: string,
    from: readonly A2aContinueIncomingState[],
    to: Exclude<A2aContinueIncomingState, 'pending' | 'decided'>,
    extra?: { rootId?: string; manifest?: A2aContinueManifestV1 },
  ): boolean {
    let rec: ContinueRequestRecordV1 | undefined;
    try {
      rec = this.deps.requests.advance(hostId, continueId, from, to, extra);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: ${to} not stored: ${errMsg(err)}`);
      return false;
    }
    if (!rec) return false;
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${to}`);
    this.sendOwed(rec);
    return true;
  }

  /** Decide an open request and send its answer. False when it is not open or the outcome was not stored. */
  private finish(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    let rec: ContinueRequestRecordV1 | undefined;
    try {
      rec = this.deps.requests.decide(hostId, continueId, code);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: ${code} not stored: ${errMsg(err)}`);
      return false;
    }
    if (!rec) return false;
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${code}`);
    this.sendOwed(rec);
    return true;
  }

  /** Queue the record's answer unless it was queued already, and remember it. */
  private sendOwed(rec: ContinueRequestRecordV1): void {
    const code = continueAnswerFor(rec);
    if (rec.state === 'pending' || rec.sent === code) return;
    if (this.sendResult(rec.hostId, rec.request.continueId, code)) this.markSent(rec, code);
  }

  /** The request's answer as it stands (`unknown` without a record), coalesced: a resend or a status query. */
  private answer(hostId: HostId, continueId: string, duplicate = false): A2aRemoteDeliverResponse {
    const rec = this.deps.requests.get(hostId, continueId);
    const code = continueAnswerFor(rec);
    const done = duplicate ? DUPLICATE : OK;
    if (this.answeredRecently(hostId, continueId, code)) return done;
    if (!this.sendResult(hostId, continueId, code)) return UNAVAILABLE;
    if (rec) this.markSent(rec, code);
    return done;
  }

  /** Answer a request that is not stored (coalesced); `unavailable` when it could not be queued, so A sends it again. */
  private refuse(hostId: HostId, continueId: string, code: A2aContinueCode): A2aRemoteDeliverResponse {
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: ${code}`);
    if (this.answeredRecently(hostId, continueId, code)) return OK;
    return this.sendResult(hostId, continueId, code) ? OK : UNAVAILABLE;
  }

  private markSent(rec: ContinueRequestRecordV1, code: A2aContinueCode): void {
    try {
      this.deps.requests.markSent(rec.hostId, rec.request.continueId, code);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue ${rec.request.continueId} from ${rec.hostId}: sent, not marked: ${errMsg(err)}`);
    }
  }

  private answeredRecently(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    const last = this.answeredAt.get(`${hostId}:${continueId}:${code}`);
    return last !== undefined && this.now() - last < this.coalesceMs;
  }

  /**
   * Queue a result; false when the outbox would not take it. Each send has
   * its own message id: `_` is in neither a continueId nor a code, and the
   * last part is new for every send (this run's start, then a count).
   */
  private sendResult(hostId: HostId, continueId: string, code: A2aContinueCode): boolean {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: continueId,
        linkVersion: 0,
        messageId: `cres_${continueId}_${code}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'continue-result', version: 0 },
        continueResult: { v: 1, continueId, code },
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] continue result ${continueId} to ${hostId} not queued: ${errMsg(err)}`);
      return false;
    }
    const k = `${hostId}:${continueId}:${code}`;
    this.answeredAt.delete(k);
    this.answeredAt.set(k, this.now());
    if (this.answeredAt.size > ANSWERED_RECENTLY_MAX) this.answeredAt.delete(this.answeredAt.keys().next().value as string);
    return true;
  }

  /** Run `step` after every check and manifest before it. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
