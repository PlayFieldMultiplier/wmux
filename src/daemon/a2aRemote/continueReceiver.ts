import path from 'node:path';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_CONTINUE_LINK_STATES,
  CONTINUE_BYTES_MAX,
  CONTINUE_FILES_MAX,
  continueAnswerFor,
  continueClaimable,
  continueClockOk,
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
import { continueManifestBytes, sameContinueBody, type ContinueRequestRecordV1, type ContinueRequestStore } from './continueRequestStore';
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
 * A request already here is always answered from its record, before any
 * policy or clock check: a refusal is final to A, and A would resume its own
 * copy of a conversation this PC may still hold and start. Only codes that
 * name what this PC holds (REPO_CODES) are hidden from a PC not allowed now.
 *
 * A new request, in this order, so a PC that may not send one learns nothing
 * else (these refusals are not stored):
 *   1. this PC takes conversations (continue policy on), from that PC, of
 *      that agent (the remote-spawn policy)            else `not-allowed`
 *   2. B's clock window (`continueClockOk`)            else `expired`
 *   3. no other open request carries that conversation, and room for one
 *      more of that PC's                                else `busy`
 *   -- stored pending; then, one request at a time:
 *   4. its estimate within this PC's caps               else `too-large`
 *   5. no pane here runs that conversation              else `busy`
 *   6. exactly one spawn root has that origin           else `repo-not-found` / `repo-ambiguous`
 *   7. room on the staging volume for the estimate      else `no-space`
 *   8. the policy and the expiry, read again after those waits
 *   9. a card can be shown                              else `not-allowed`
 *      → `awaiting` (`waiting-for-approval`); the card answers `decide`.
 *
 * Then: approved → `ready`; the manifest (`receiving`), checked against the
 * policy, the request's commit, the caps and the disk; `received` once
 * PR2b's route has every file in staging; `claim` → `starting`, only while
 * `continueClaimable` and after the pane, policy and root checks again;
 * `started` / `failed`. An unclaimed request past its expiry ends `expired`
 * on the sweep. A claimed one is never started again. One main never
 * reported on is settled only after CONTINUE_STARTING_GRACE_MS, by whether a
 * pane here runs the conversation: a blind `failed` would let A resume its
 * own copy beside a start that did happen.
 */

/** The same answer to the same request goes out at most once in this window (a resend, a status query). */
export const CONTINUE_RESEND_COALESCE_MS = 60_000;
/** A claimed start main never reported on is settled after this long since its claim. */
export const CONTINUE_STARTING_GRACE_MS = 10 * 60 * 1000;
/** Recent answers remembered for coalescing. */
const ANSWERED_RECENTLY_MAX = 1000;
/** Open states before main claims a request: the sweep expires these. */
const UNCLAIMED: readonly A2aContinueIncomingState[] = ['pending', 'awaiting', 'ready', 'receiving', 'received'];
/** Codes that say what this PC holds: a PC not allowed now hears `not-allowed` instead. */
const REPO_CODES: ReadonlySet<A2aContinueCode> = new Set<A2aContinueCode>([
  'repo-not-found', 'repo-ambiguous', 'branch-not-found', 'branch-busy', 'head-missing', 'diverged',
]);

export interface ContinueReceiverDeps {
  policy: Pick<ContinuePolicyStore, 'get'>;
  /** The PCs, folders and agents this PC takes work from. */
  spawnPolicy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<ContinueRequestStore, 'get' | 'inState' | 'unsent' | 'receive' | 'advance' | 'decide' | 'markSent' | 'prune' | 'reservedBytes'>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** The origin of the repository at a spawn root, as originUrlRepoKey writes it; null without one. */
  originKeyOf: (rootPath: string) => Promise<string | null>;
  /**
   * Free bytes on the staging volume (the a2a dir's), where a conversation's
   * bytes land. The Claude config dir's and the root's volumes are the
   * placer's to check (ContinueClaim.bytes).
   */
  freeBytes: () => Promise<number>;
  /** A pane on this PC runs the conversation `sessionId` (paneHoldsSession). */
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
  /**
   * What placing it takes on disk. Only the staging volume was checked here:
   * the placer checks the Claude config dir's volume and the root's (for the
   * worktree) before it writes there.
   */
  bytes: number;
}

export type ContinueStepResult = { ok: true } | { ok: false; error: string };
export type ContinueClaimResult = { ok: true; claim: ContinueClaim } | { ok: false; error: string };

export function isContinueEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: A2aContinueLinkState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s !== undefined && (A2A_CONTINUE_LINK_STATES as readonly string[]).includes(s);
}

/**
 * Whether a pane runs the conversation `sessionId`: its own resume binding
 * names it (from the agent's hooks, or its launch line's `--resume` /
 * `--session-id`), or, with no binding, the transcript bound to it is that
 * conversation's. The transcript (a path resolution) is read only then.
 */
export function paneHoldsSession(pane: { resumeBinding?: { sessionId: string } }, transcriptPath: () => string | null, sessionId: string): boolean {
  if (pane.resumeBinding) return pane.resumeBinding.sessionId === sessionId;
  const transcript = transcriptPath();
  return transcript !== null && path.basename(transcript) === `${sessionId}.jsonl`;
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
  /** When each PC was last told `unknown`: at most once per window, whatever the id. */
  private readonly unknownAt = new Map<HostId, number>();
  /** Each spawn root's origin, for one version of the spawn policy. */
  private origins: { version: number; keys: Map<string, string | null> } = { version: -1, keys: new Map() };
  /** Checks, manifests and claims, one at a time: their disk and git checks share one bounded gate. */
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

  /** After a restart: check what is pending, settle starts left behind, send what was owed, expire what ran out. */
  recover(): void {
    for (const rec of this.deps.requests.inState('pending')) {
      const { hostId } = rec;
      const { continueId } = rec.request;
      void this.serial(() => this.check(hostId, continueId));
    }
    this.sweep();
  }

  /**
   * Unclaimed requests past their expiry end `expired`; claimed starts past
   * their grace are settled; owed answers go again; old decided records go.
   */
  sweep(): void {
    for (const state of UNCLAIMED) {
      for (const rec of this.deps.requests.inState(state)) {
        if (this.expired(rec)) this.finish(rec.hostId, rec.request.continueId, 'expired');
      }
    }
    this.settleStarts();
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
   * (never after its expiry, never twice), while the policy still allows that
   * PC, no pane here runs the conversation, and the root it matched is still
   * the one root with that origin (read again, not from the cache). A
   * refusal ends the request; a root that could not be read now leaves it
   * received for main to try again.
   */
  claim(hostId: HostId, continueId: string): Promise<ContinueClaimResult> {
    return this.serial(() => this.claimNow(hostId, continueId));
  }

  /** Main started the claimed conversation in a pane. */
  started(hostId: HostId, continueId: string): ContinueStepResult {
    return this.endStart(hostId, continueId, 'started');
  }

  /** Main could not start the claimed conversation. */
  failed(hostId: HostId, continueId: string): ContinueStepResult {
    return this.endStart(hostId, continueId, 'failed');
  }

  /** A paired PC was removed: what this receiver keeps for it in memory goes too. */
  forgetHost(hostId: HostId): void {
    for (const k of [...this.answeredAt.keys()]) if (k.startsWith(`${hostId}:`)) this.answeredAt.delete(k);
    this.unknownAt.delete(hostId);
  }

  /** Settle every check, manifest and claim in flight (tests). */
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

  private async claimNow(hostId: HostId, continueId: string): Promise<ContinueClaimResult> {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'received' || !rec.manifest || !rec.rootId) return { ok: false, error: 'this request is not received, or is already starting' };
    const refuse = (code: A2aContinueCode): ContinueClaimResult => (this.finish(hostId, continueId, code) ? { ok: false, error: code } : NOT_STORED);
    const before = this.claimRefusal(rec);
    if (before) return refuse(before);
    let matched: Array<{ id: string; path: string }>;
    try {
      matched = await this.rootsWithOrigin(rec.request.repo.origin, true);
    } catch (err) {
      return { ok: false, error: `the folder was not checked now, try again: ${errMsg(err)}` };
    }
    // The read waited: the clock, the policy and the panes once more.
    const after = this.claimRefusal(rec);
    if (after) return refuse(after);
    if (matched.length > 1) return refuse('repo-ambiguous');
    const root = this.deps.spawnPolicy.get().roots.find((r) => r.id === rec.rootId);
    if (!root || matched[0]?.id !== root.id || matched[0].path !== root.path) return refuse('not-allowed');
    if (!this.step(hostId, continueId, ['received'], 'starting')) return { ok: false, error: 'this request is not received, or is already starting' };
    return {
      ok: true,
      claim: {
        hostId,
        request: rec.request,
        manifest: rec.manifest,
        rootId: root.id,
        rootPath: root.path,
        permissionMode: this.deps.policy.get().in.permissionMode,
        bytes: continueManifestBytes(rec.manifest),
      },
    };
  }

  /** Why a received request may not start now, if it may not. */
  private claimRefusal(rec: ContinueRequestRecordV1): A2aContinueCode | undefined {
    if (!continueClaimable(rec, this.now())) return 'expired';
    if (!this.allowed(rec.hostId, rec.request)) return 'not-allowed';
    // A pane here runs the conversation already: this PC never starts a second one.
    if (this.deps.sessionLive(rec.request.sessionId)) return 'busy';
    return undefined;
  }

  private endStart(hostId: HostId, continueId: string, code: 'started' | 'failed'): ContinueStepResult {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'starting') return { ok: false, error: 'this request is not starting' };
    return this.finish(hostId, continueId, code) ? { ok: true } : NOT_STORED;
  }

  /**
   * A claimed start main never reported on (it stopped, or its report was
   * lost), once CONTINUE_STARTING_GRACE_MS have passed since the claim
   * (a starting record's `updatedAt`): `started` when a pane here runs the
   * conversation, else `failed`. Never sooner, so a start still under way is
   * not called failed.
   */
  private settleStarts(): void {
    for (const rec of this.deps.requests.inState('starting')) {
      if (this.now() - Date.parse(rec.updatedAt) <= CONTINUE_STARTING_GRACE_MS) continue;
      this.finish(rec.hostId, rec.request.continueId, this.deps.sessionLive(rec.request.sessionId) ? 'started' : 'failed');
    }
  }

  private receive(hostId: HostId, req: A2aContinueRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // Its record answers a request already here, before the policy or the clock: see the top of this file.
    const known = this.deps.requests.get(hostId, req.continueId);
    if (known) return sameContinueBody(known.request, req) ? this.answer(hostId, req.continueId, true) : CONFLICT;
    if (!this.allowed(hostId, req)) return this.refuse(hostId, req.continueId, 'not-allowed');
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
    const matched = await this.rootsWithOrigin(req.repo.origin, false);
    if (matched.length === 0) return 'repo-not-found';
    if (matched.length > 1) return 'repo-ambiguous';
    if (!(await this.roomFor(req.estimate.bytes))) return 'no-space';
    if (this.expired(rec)) return 'expired';
    if (!this.deps.cardAvailable?.()) return 'not-allowed';
    return { rootId: matched[0].id };
  }

  /**
   * The spawn roots whose origin is `origin`. Each root's origin is read once
   * per spawn-policy version; `fresh` reads every root again (and keeps what
   * it read). An error is thrown, never kept.
   */
  private async rootsWithOrigin(origin: string, fresh: boolean): Promise<Array<{ id: string; path: string }>> {
    const policy = this.deps.spawnPolicy.get();
    if (this.origins.version !== policy.version) this.origins = { version: policy.version, keys: new Map() };
    const keys = this.origins.keys;
    const matched: Array<{ id: string; path: string }> = [];
    for (const root of policy.roots) {
      let key = fresh ? undefined : keys.get(root.path);
      if (key === undefined) {
        // eslint-disable-next-line no-await-in-loop -- one git read at a time, through the bounded gate
        key = await this.checks.run(() => this.deps.originKeyOf(root.path));
        keys.set(root.path, key);
      }
      if (key === origin) matched.push({ id: root.id, path: root.path });
    }
    return matched;
  }

  /** Room on the staging volume for `bytes`, beside what this PC's other received conversations hold there. */
  private async roomFor(bytes: number): Promise<boolean> {
    const free = await this.checks.run(() => this.deps.freeBytes());
    return free - this.deps.requests.reservedBytes() >= bytes;
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
    const bytes = continueManifestBytes(manifest);
    // First the policy (a PC no longer allowed learns nothing of this PC's checkout) and the clock.
    const refusal = (): A2aContinueCode | undefined => {
      if (!this.allowed(hostId, rec.request)) return 'not-allowed';
      return this.expired(rec) ? 'expired' : undefined;
    };
    let code = refusal();
    // A's checkout moved on while B decided: what it took is of another commit.
    if (!code && manifest.head !== rec.request.repo.head) code = 'diverged';
    if (!code && (bytes > this.limits.bytes || manifest.files.length > this.limits.files)) code = 'too-large';
    if (!code) {
      let room: boolean;
      try {
        room = await this.roomFor(bytes);
      } catch (err) {
        // Not settled: A sends the manifest again (or the request expires).
        this.deps.log('warn', `[a2a-remote] continue ${manifest.continueId} from ${hostId}: free space not read: ${errMsg(err)}`);
        return UNAVAILABLE;
      }
      // The disk took a while: the policy and the clock again.
      code = refusal() ?? (room ? undefined : 'no-space');
    }
    if (code) return this.finish(hostId, manifest.continueId, code) ? OK : UNAVAILABLE;
    return this.step(hostId, manifest.continueId, ['ready'], 'receiving', { manifest }) ? OK : UNAVAILABLE;
  }

  /** This PC takes conversations from `hostId` (and of the request's agent, given one). The parser checked the agent can move. */
  private allowed(hostId: HostId, req?: A2aContinueRequestV1): boolean {
    const spawn = this.deps.spawnPolicy.get();
    return this.deps.policy.get().in.enabled && spawnHostAllowed(spawn, hostId) && (!req || spawn.agents.includes(req.agent));
  }

  /** Past its expiry by B's clock: the claim's own test (continueClaimable), whatever state the record is in. */
  private expired(rec: ContinueRequestRecordV1): boolean {
    return !continueClaimable({ ...rec, state: 'received' }, this.now());
  }

  /** What `code` reads as to the record's PC: nothing of what this PC holds once that PC is not allowed. */
  private shown(rec: ContinueRequestRecordV1, code: A2aContinueCode): A2aContinueCode {
    return REPO_CODES.has(code) && !this.allowed(rec.hostId, rec.request) ? 'not-allowed' : code;
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
    if (this.sendResult(rec.hostId, rec.request.continueId, this.shown(rec, code))) this.markSent(rec, code);
  }

  /**
   * The request's answer as it stands, coalesced: a resend or a status query.
   * An id this PC holds no record of gets nothing when that PC is not
   * allowed, and `unknown` at most once per window when it is, so made-up
   * ids cannot fill the outbox.
   */
  private answer(hostId: HostId, continueId: string, duplicate = false): A2aRemoteDeliverResponse {
    const done = duplicate ? DUPLICATE : OK;
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec) {
      if (!this.allowed(hostId)) return done;
      const last = this.unknownAt.get(hostId);
      if (last !== undefined && this.now() - last < this.coalesceMs) return done;
      if (!this.sendResult(hostId, continueId, 'unknown')) return UNAVAILABLE;
      this.unknownAt.set(hostId, this.now());
      return done;
    }
    const code = continueAnswerFor(rec);
    const shown = this.shown(rec, code);
    if (this.answeredRecently(hostId, continueId, shown)) return done;
    if (!this.sendResult(hostId, continueId, shown)) return UNAVAILABLE;
    this.markSent(rec, code);
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

  /** Run `step` after every check, manifest and claim before it. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
