import fs from 'node:fs';
import path from 'node:path';
import { agentExecEnv } from '../../shared/execEnv';
import { agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_SPAWN_RPC,
  SPAWN_TARGETS_LINK_ID,
  isFinalSpawnCode,
  normalizeSpawnSub,
  parseSpawnRequest,
  parseSpawnResult,
  parseSpawnTargets,
  spawnClockOk,
  spawnHostAllowed,
  spawnTargetsFor,
  type A2aSpawnCode,
  type A2aSpawnRequestV1,
  type A2aSpawnResultV1,
  type A2aSpawnTargetsV1,
} from '../../shared/a2aSpawn';
import { sanitizeRemoteMessage } from '../../shared/a2aRemoteDelivery';
import { whichOnPath } from '../web/agentLaunch';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import { samePath } from './spawnPolicyStore';
import { CheckTimeout, notThere, spawnChecks, type SpawnChecks } from './spawnChecks';
import { spawnFingerprint, type SpawnRequestRecordV1, type SpawnRequestStore } from './spawnRequestStore';
import { errMsg, isPlainObject } from './storeFile';

/**
 * Remote spawn, the transport side (both roles; see `shared/a2aSpawn.ts`).
 *
 * Receiving a request (this PC is B): only cheap checks run before the
 * answer, which is `ok` for anything readable. A request that fails one is
 * answered and not stored; one that passes is stored pending and decided
 * right after. Either way its outcome goes back as a `spawn-result` envelope
 * through this PC's own outbox, so it reaches A whichever side joined, and
 * nothing that waits ever holds up the transport.
 *
 * Order of the checks, so a PC that may not ask learns nothing else:
 *   1. this PC opted in (feature on, host allowed)  else `not-allowed`
 *   -- a request already here: its stored outcome is sent again (or its
 *      decision resumed); the same id with another body is a `conflict`
 *   2. B's clock window (`spawnClockOk`)              else `expired`
 *   3. room (pending per PC, records kept)            else `rate-limited`
 *   -- answered `ok` here; then, decided:
 *   4. the agent is on B's list                       else `agent-not-allowed`
 *   5. the agent is installed                         else `agent-not-installed`
 *   6. the root is listed, still resolves to itself,
 *      and root + sub stays inside it, as a folder    else `folder-not-allowed`
 *   7. the policy and the expiry, read again after those waits
 *   8. nothing starts a spawn in this build           `not-supported`
 *
 * The same answer to the same request goes out at most once per
 * `SPAWN_REFUSAL_COALESCE_MS`. Each disk or PATH check goes through
 * `spawnChecks` (bounded in time, and in number process-wide; past the time
 * the request ends `failed`). Any other error keeps the request pending and
 * tries again later, until it expires.
 *
 * Receiving a result or targets (this PC is A): handed on only for a request
 * this PC sent and that has no final answer yet, and only newer targets.
 */

/** Pending requests one PC may have here at once. */
export const SPAWN_PENDING_PER_HOST_MAX = 3;
/** The same answer to the same request of one PC is sent at most once in this window. */
export const SPAWN_REFUSAL_COALESCE_MS = 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Final answers this PC remembers having handed on (as A). */
const ANSWERED_MAX = 1000;
/** Recent answers remembered for coalescing. */
const ANSWERED_RECENTLY_MAX = 1000;

export interface SpawnReceiverDeps {
  policy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<SpawnRequestStore, 'get' | 'receive' | 'decide' | 'pending' | 'pendingCount' | 'markSent' | 'unsent'>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** Whether this PC can run `agent` (its launcher on the login PATH). */
  agentInstalled?: (agent: AgentSlug) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  /** Whether `p` is a folder; rejects with the stat error when it cannot tell. */
  isDirectory?: (p: string) => Promise<boolean>;
  /** As A: a request this PC sent to `hostId` that is still waiting for an answer. None yet in this build. */
  isOutstanding?: (hostId: HostId, spawnId: string) => boolean;
  /** As A: an answer to one of this PC's requests, or newer targets. */
  onResult?: (hostId: HostId, result: A2aSpawnResultV1) => void;
  onTargets?: (hostId: HostId, targets: A2aSpawnTargetsV1) => void;
  now?: () => number;
  /** Test seams. */
  checks?: SpawnChecks;
  retryMinMs?: number;
  refusalCoalesceMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

type SpawnEnvelopeState = 'spawn' | 'spawn-result' | 'spawn-targets';

export function isSpawnEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: SpawnEnvelopeState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s === 'spawn' || s === 'spawn-result' || s === 'spawn-targets';
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const UNAVAILABLE: A2aRemoteDeliverResponse = { ok: false, error: 'unavailable' };

export class A2aSpawnReceiver {
  private readonly deps: SpawnReceiverDeps;
  private readonly now: () => number;
  private readonly agentInstalled: (agent: AgentSlug) => Promise<boolean>;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly isDirectory: (p: string) => Promise<boolean>;
  private readonly checks: SpawnChecks;
  private readonly retryMinMs: number;
  private readonly refusalCoalesceMs: number;
  /** Makes every result's message id new, across restarts too. */
  private readonly boot: string;
  private sends = 0;
  private stopped = false;
  /** Decisions in flight, by host:spawnId, so one is never decided twice at once. */
  private readonly deciding = new Map<string, Promise<void>>();
  /** Decisions waiting to try again, by host:spawnId. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each answer (host:spawnId:code) was last sent. */
  private readonly answeredAt = new Map<string, number>();
  /** As A: host:spawnId whose final answer was handed on. */
  private readonly answered = new Set<string>();
  /** As A: the newest targets version each PC sent. */
  private readonly targetsVersion = new Map<HostId, number>();

  constructor(deps: SpawnReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.agentInstalled = deps.agentInstalled ?? agentOnPath;
    this.realpath = deps.realpath ?? ((p) => fs.promises.realpath(p));
    this.isDirectory = deps.isDirectory ?? ((p) => fs.promises.stat(p).then((s) => s.isDirectory()));
    this.checks = deps.checks ?? spawnChecks;
    this.retryMinMs = deps.retryMinMs ?? RETRY_MIN_MS;
    this.refusalCoalesceMs = deps.refusalCoalesceMs ?? SPAWN_REFUSAL_COALESCE_MS;
    this.boot = this.now().toString(36);
  }

  /** One spawn envelope from an authenticated peer. Never waits on a decision. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    const state = env.link?.state;
    if (env.linkVersion !== 0) return { ok: false, error: 'bad-request' };
    if (state === 'spawn-result') {
      const result = parseSpawnResult(env.spawnResult);
      if (!result || result.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
      this.takeResult(peer.hostId, result);
      return OK;
    }
    if (state === 'spawn-targets') {
      const targets = parseSpawnTargets(env.spawnTargets);
      if (!targets || env.linkId !== SPAWN_TARGETS_LINK_ID) return { ok: false, error: 'bad-request' };
      if (targets.version > (this.targetsVersion.get(peer.hostId) ?? -1)) {
        this.targetsVersion.set(peer.hostId, targets.version);
        this.deps.onTargets?.(peer.hostId, targets);
      }
      return OK;
    }
    // The prompt reaches a terminal later: control characters and escape
    // sequences go first, and only then is it checked for being empty.
    const raw = env.spawn as unknown;
    const clean = isPlainObject(raw) && typeof raw['text'] === 'string' ? { ...raw, text: sanitizeRemoteMessage(raw['text']) } : raw;
    const req = parseSpawnRequest(clean);
    if (!req || req.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
    return this.receive(peer.hostId, req, env.sentAt);
  }

  /** What `hostId` may ask for, as an envelope; null when it may not ask. Not sent until spawning ships. */
  targetsEnvelope(hostId: HostId): A2aRemoteEnvelope | null {
    const targets = spawnTargetsFor(this.deps.policy.get(), hostId);
    if (!targets) return null;
    return {
      protocol: A2A_REMOTE_PROTOCOL,
      linkId: SPAWN_TARGETS_LINK_ID,
      linkVersion: 0,
      messageId: `st-${targets.version}`,
      kind: 'link',
      link: { state: 'spawn-targets', version: 0 },
      spawnTargets: targets,
      sentAt: new Date(this.now()).toISOString(),
    };
  }

  /** After a restart: decide what is pending, send what was decided but never left. */
  recover(): void {
    for (const rec of this.deps.requests.pending()) this.scheduleDecide(rec.hostId, rec.spawnId);
    for (const rec of this.deps.requests.unsent()) this.sendDecided(rec);
  }

  /**
   * A paired PC was removed: whatever this receiver keeps for it in memory
   * goes too, so a re-paired PC starts from nothing (its targets from v1).
   * A decision already running ends without an answer: its record is gone.
   */
  forgetHost(hostId: HostId): void {
    const mine = (k: string): boolean => k.startsWith(`${hostId}:`);
    for (const [k, t] of this.retries) if (mine(k)) { clearTimeout(t); this.retries.delete(k); }
    for (const k of [...this.deciding.keys()]) if (mine(k)) this.deciding.delete(k);
    for (const k of [...this.answeredAt.keys()]) if (mine(k)) this.answeredAt.delete(k);
    for (const k of [...this.answered]) if (mine(k)) this.answered.delete(k);
    this.targetsVersion.delete(hostId);
  }

  /** Settle every decision in flight (tests). Retries waiting on a timer are not waited for. */
  async idle(): Promise<void> {
    while (this.deciding.size > 0) await Promise.all([...this.deciding.values()]);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
  }

  // --- B: requests --------------------------------------------------------------

  private receive(hostId: HostId, req: A2aSpawnRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // A PC that may not ask learns nothing else, not even what it asked before.
    const policy = this.deps.policy.get();
    if (!spawnHostAllowed(policy, hostId)) return this.refuse(hostId, req.spawnId, 'not-allowed');

    // A request already here is answered from what was stored, whatever the
    // clock says now: the asker may have lost the first answer.
    const known = this.deps.requests.get(hostId, req.spawnId);
    if (known) {
      if (known.fingerprint !== spawnFingerprint(req)) return { ok: false, error: 'conflict' };
      return this.resume(known);
    }

    // A request refused here is not stored: a PC that may not ask cannot
    // grow this PC's files. Its resend is refused the same way again.
    let refused: A2aSpawnCode | undefined;
    if (!spawnClockOk(sentAt, req.expiresAt, this.now())) refused = 'expired';
    else if (this.deps.requests.pendingCount(hostId) >= SPAWN_PENDING_PER_HOST_MAX) refused = 'rate-limited';
    if (refused) return this.refuse(hostId, req.spawnId, refused);

    let got: ReturnType<SpawnReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request from ${hostId} not stored: ${errMsg(err)}`);
      return UNAVAILABLE;
    }
    if (got.kind === 'conflict') return { ok: false, error: 'conflict' };
    if (got.kind === 'duplicate') return this.resume(got.rec);
    if (got.kind === 'full') return this.refuse(hostId, req.spawnId, 'rate-limited');
    this.deps.log('info', `[a2a-remote] spawn request ${req.spawnId} from ${hostId}: agent ${req.agent}, root ${req.folder.root}`);
    this.scheduleDecide(hostId, req.spawnId);
    return OK;
  }

  /**
   * Answer a request that is not stored. A resend of the same request gets
   * the same answer at most once per `SPAWN_REFUSAL_COALESCE_MS`; one that
   * could not be queued is `unavailable`, so the asker sends it again.
   */
  private refuse(hostId: HostId, spawnId: string, code: A2aSpawnCode): A2aRemoteDeliverResponse {
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    if (this.answeredRecently(hostId, spawnId, code)) return OK;
    return this.sendResult(hostId, { v: 1, spawnId, code }) ? OK : UNAVAILABLE;
  }

  /** A request already stored: send its outcome again (coalesced), or make sure it is being decided. */
  private resume(rec: SpawnRequestRecordV1): A2aRemoteDeliverResponse {
    if (rec.state === 'pending') {
      this.scheduleDecide(rec.hostId, rec.spawnId);
      return { ok: true, duplicate: true };
    }
    if (rec.code && this.answeredRecently(rec.hostId, rec.spawnId, rec.code)) return { ok: true, duplicate: true };
    return this.sendDecided(rec) ? { ok: true, duplicate: true } : UNAVAILABLE;
  }

  private answeredRecently(hostId: HostId, spawnId: string, code: A2aSpawnCode): boolean {
    const last = this.answeredAt.get(`${hostId}:${spawnId}:${code}`);
    return last !== undefined && this.now() - last < this.refusalCoalesceMs;
  }

  private sendDecided(rec: SpawnRequestRecordV1): boolean {
    if (!rec.code) return false;
    if (!this.sendResult(rec.hostId, { v: 1, spawnId: rec.spawnId, code: rec.code })) return false;
    try {
      this.deps.requests.markSent(rec.hostId, rec.spawnId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${rec.spawnId} from ${rec.hostId}: sent, not marked: ${errMsg(err)}`);
    }
    return true;
  }

  private scheduleDecide(hostId: HostId, spawnId: string, attempt = 0): void {
    if (this.stopped) return;
    const k = `${hostId}:${spawnId}`;
    if (this.deciding.has(k) || (attempt === 0 && this.retries.has(k))) return;
    this.retries.delete(k);
    const run: Promise<void> = (async () => {
      let code: A2aSpawnCode;
      try {
        code = await this.decide(hostId, spawnId);
      } catch (err) {
        if (!(err instanceof CheckTimeout)) {
          this.retryLater(hostId, spawnId, attempt, err);
          return;
        }
        this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: a check did not answer in time`);
        code = 'failed';
      }
      this.settle(hostId, spawnId, code, attempt);
    })().finally(() => {
      // Cleared whatever happened, so a retry is never turned away as "already deciding".
      if (this.deciding.get(k) === run) this.deciding.delete(k);
    });
    this.deciding.set(k, run);
  }

  /**
   * An error that may pass (a busy or failing disk, an outcome not stored):
   * the request stays pending and is tried again later; once it has expired
   * it ends `expired`.
   */
  private retryLater(hostId: HostId, spawnId: string, attempt: number, err: unknown): void {
    if (this.stopped) return;
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    const delay = Math.min(this.retryMinMs * 2 ** attempt, RETRY_MAX_MS);
    this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: not decided yet, trying again in ${Math.round(delay / 1000)}s: ${errMsg(err)}`);
    const k = `${hostId}:${spawnId}`;
    clearTimeout(this.retries.get(k));
    const t = setTimeout(() => {
      this.retries.delete(k);
      const now = this.deps.requests.get(hostId, spawnId);
      if (!now || now.state !== 'pending') return;
      if (this.now() > Date.parse(now.expiresAt)) this.settle(hostId, spawnId, 'expired', attempt + 1);
      else this.scheduleDecide(hostId, spawnId, attempt + 1);
    }, delay);
    t.unref?.();
    this.retries.set(k, t);
  }

  private async decide(hostId: HostId, spawnId: string): Promise<A2aSpawnCode> {
    const rec = this.deps.requests.get(hostId, spawnId);
    const req = rec?.request;
    if (!rec || rec.state !== 'pending' || !req) return 'failed';
    const policy = this.deps.policy.get();
    // The policy may have changed since the request arrived.
    if (!spawnHostAllowed(policy, hostId)) return 'not-allowed';
    if (this.now() > Date.parse(req.expiresAt)) return 'expired';
    if (!policy.agents.includes(req.agent)) return 'agent-not-allowed';
    // Nothing that could leave the root reaches the disk (parsed so already; checked again here).
    const sub = normalizeSpawnSub(req.folder.sub);
    const root = policy.roots.find((r) => r.id === req.folder.root);
    if (sub === null || !root) return 'folder-not-allowed';
    if (!(await this.checks.run(() => this.agentInstalled(req.agent)))) return 'agent-not-installed';
    if (!(await this.folderInside(root.path, sub))) return 'folder-not-allowed';
    // The checks above wait on the disk and the PATH: the human may have
    // turned this PC (or that root, or that agent) off meanwhile, and the
    // request may have expired.
    const now = this.deps.policy.get();
    if (!spawnHostAllowed(now, hostId)) return 'not-allowed';
    if (!now.agents.includes(req.agent) || !now.roots.some((r) => r.id === root.id && r.path === root.path)) return 'not-allowed';
    if (this.now() > Date.parse(req.expiresAt)) return 'expired';
    return 'not-supported';
  }

  /**
   * `sub` below `rootPath` stays inside it once every link is resolved, and is
   * a folder. The root itself must still resolve to the path stored when it
   * was added: a root replaced by a link elsewhere is refused. The realpaths
   * are compared as they are (no case folding: on a case-sensitive volume a
   * sibling that differs only by case is another folder). The folder is
   * resolved again after the directory check, so a swap in between is seen.
   * Only "not there" errors refuse; any other (out of file handles, I/O)
   * is thrown, and the decision is tried again.
   * Whatever starts an agent later checks again right before it does.
   */
  private async folderInside(rootPath: string, sub: string): Promise<boolean> {
    const target = (rootReal: string): string => (sub ? path.join(rootReal, ...sub.split('/')) : rootReal);
    try {
      const rootReal = await this.checks.run(() => this.realpath(rootPath));
      const real = await this.checks.run(() => this.realpath(target(rootReal)));
      if (!samePath(rootReal, rootPath) || !inside(rootReal, real)) return false;
      if (!(await this.checks.run(() => this.isDirectory(real)))) return false;
      return (await this.checks.run(() => this.realpath(target(rootReal)))) === real;
    } catch (err) {
      if (notThere(err)) return false;
      throw err;
    }
  }

  private settle(hostId: HostId, spawnId: string, code: A2aSpawnCode, attempt: number): void {
    if (this.stopped) return;
    // The PC was removed (its requests forgotten) while this was decided: nothing goes back.
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    let decided: SpawnRequestRecordV1 | undefined;
    try {
      decided = isFinalSpawnCode(code) ? this.deps.requests.decide(hostId, spawnId, code) : undefined;
    } catch (err) {
      // Not stored: the request stays pending and is settled again later.
      this.retryLater(hostId, spawnId, attempt, err);
      return;
    }
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    if (decided) this.sendDecided(decided);
    else this.sendResult(hostId, { v: 1, spawnId, code });
  }

  /**
   * Queue a result; false when the outbox would not take it. Each send has
   * its own message id: `_` is in neither a spawnId nor a code, and the last
   * part is new for every send (this run's start, then a count).
   */
  private sendResult(hostId: HostId, result: A2aSpawnResultV1): boolean {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: result.spawnId,
        linkVersion: 0,
        messageId: `res_${result.spawnId}_${result.code}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'spawn-result', version: 0 },
        spawnResult: result,
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn result ${result.spawnId} to ${hostId} not queued: ${errMsg(err)}`);
      return false;
    }
    this.answeredAt.delete(`${hostId}:${result.spawnId}:${result.code}`);
    this.answeredAt.set(`${hostId}:${result.spawnId}:${result.code}`, this.now());
    if (this.answeredAt.size > ANSWERED_RECENTLY_MAX) this.answeredAt.delete(this.answeredAt.keys().next().value as string);
    return true;
  }

  // --- A: answers ---------------------------------------------------------------

  /** An answer is handed on only for a request this PC sent and that has no final answer yet. */
  private takeResult(hostId: HostId, result: A2aSpawnResultV1): void {
    const k = `${hostId}:${result.spawnId}`;
    if (this.answered.has(k) || this.deps.isOutstanding?.(hostId, result.spawnId) !== true) {
      this.deps.log('info', `[a2a-remote] spawn result ${result.spawnId} from ${hostId} ignored: no request of this PC waits for it`);
      return;
    }
    if (isFinalSpawnCode(result.code)) {
      this.answered.add(k);
      if (this.answered.size > ANSWERED_MAX) this.answered.delete(this.answered.values().next().value as string);
    }
    this.deps.onResult?.(hostId, result);
  }
}

function inside(rootReal: string, real: string): boolean {
  const rel = path.relative(rootReal, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The agent's launcher on the login shell's PATH (`PATHEXT` on Windows). */
async function agentOnPath(agent: AgentSlug): Promise<boolean> {
  const row = agentRow(agent);
  if (!row) return false;
  const stem = agentLauncherStem(row);
  const env = await agentExecEnv(process.env);
  if (process.platform !== 'win32') return (await whichOnPath(stem, env.PATH ?? '')) !== undefined;
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const dir of (env.Path ?? env.PATH ?? '').split(';')) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      if (await fs.promises.stat(path.join(dir, stem + ext.toLowerCase())).then((s) => s.isFile(), () => false)) return true;
    }
  }
  return false;
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** The machine-local policy RPCs (`wmux.internal`). */
export function registerSpawnRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  deps: { policy: Pick<SpawnPolicyStore, 'get' | 'set'>; requests: Pick<SpawnRequestStore, 'summaries'> },
): void {
  onRpc(A2A_SPAWN_RPC.policyGet, async () => ({ policy: deps.policy.get() }));
  onRpc(A2A_SPAWN_RPC.policySet, async (params) => deps.policy.set(params['policy']));
  onRpc(A2A_SPAWN_RPC.requestsList, async () => ({ requests: deps.requests.summaries() }));
}
