import fs from 'node:fs';
import path from 'node:path';
import { agentExecEnv } from '../../shared/execEnv';
import { agentLauncherStem, agentRow, type AgentSlug } from '../../shared/agentIdentity';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  A2A_SPAWN_RPC,
  SPAWN_TARGETS_LINK_ID,
  isFinalSpawnCode,
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
 *   0. a request already here: its stored outcome is sent again (or its
 *      decision resumed); the same id with another body is a `conflict`
 *   1. this PC opted in (feature on, host allowed)  else `not-allowed`
 *   2. B's clock window (`spawnClockOk`)              else `expired`
 *   3. room (pending per PC, records kept)            else `rate-limited`
 *   -- answered `ok` here; then, decided:
 *   4. the agent is on B's list                       else `agent-not-allowed`
 *   5. the agent is installed                         else `agent-not-installed`
 *   6. the root is listed, still resolves to itself,
 *      and root + sub stays inside it, as a folder    else `folder-not-allowed`
 *   7. the policy, read again after those waits
 *   8. nothing starts a spawn in this build           `not-supported`
 *
 * Each disk or PATH check is bounded (`SPAWN_CHECK_TIMEOUT_MS`; past it the
 * request ends `failed`). Any other error keeps the request pending and
 * tries again later, until it expires.
 *
 * Receiving a result or targets (this PC is A): handed on only for a request
 * this PC sent and that has no final answer yet, and only newer targets.
 */

/** Pending requests one PC may have here at once. */
export const SPAWN_PENDING_PER_HOST_MAX = 3;
/** Requests refused before they are stored: one answer per code per PC in this window. */
export const SPAWN_REFUSAL_COALESCE_MS = 60_000;
/** One disk or PATH check of a decision. */
export const SPAWN_CHECK_TIMEOUT_MS = 10_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Final answers this PC remembers having handed on (as A). */
const ANSWERED_MAX = 1000;

export interface SpawnReceiverDeps {
  policy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<SpawnRequestStore, 'get' | 'receive' | 'decide' | 'pending' | 'pendingCount' | 'markSent' | 'unsent'>;
  /** Queue an envelope to `hostId` (the delivery outbox); throws when it cannot. */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** Whether this PC can run `agent` (its launcher on the login PATH). */
  agentInstalled?: (agent: AgentSlug) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
  /** As A: a request this PC sent to `hostId` that is still waiting for an answer. None yet in this build. */
  isOutstanding?: (hostId: HostId, spawnId: string) => boolean;
  /** As A: an answer to one of this PC's requests, or newer targets. */
  onResult?: (hostId: HostId, result: A2aSpawnResultV1) => void;
  onTargets?: (hostId: HostId, targets: A2aSpawnTargetsV1) => void;
  now?: () => number;
  /** Test seams. */
  checkTimeoutMs?: number;
  retryMinMs?: number;
  refusalCoalesceMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

type SpawnEnvelopeState = 'spawn' | 'spawn-result' | 'spawn-targets';

export function isSpawnEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: SpawnEnvelopeState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s === 'spawn' || s === 'spawn-result' || s === 'spawn-targets';
}

class CheckTimeout extends Error {}

export class A2aSpawnReceiver {
  private readonly deps: SpawnReceiverDeps;
  private readonly now: () => number;
  private readonly agentInstalled: (agent: AgentSlug) => Promise<boolean>;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly isDirectory: (p: string) => Promise<boolean>;
  private readonly checkTimeoutMs: number;
  private readonly retryMinMs: number;
  private readonly refusalCoalesceMs: number;
  /** Decisions in flight, by host:spawnId, so one is never decided twice at once. */
  private readonly deciding = new Map<string, Promise<void>>();
  /** Decisions waiting to try again, by host:spawnId. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each (host, code) refusal was last answered. */
  private readonly refusedAt = new Map<string, number>();
  /** As A: host:spawnId whose final answer was handed on. */
  private readonly answered = new Set<string>();
  /** As A: the newest targets version each PC sent. */
  private readonly targetsVersion = new Map<HostId, number>();

  constructor(deps: SpawnReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.agentInstalled = deps.agentInstalled ?? agentOnPath;
    this.realpath = deps.realpath ?? ((p) => fs.promises.realpath(p));
    this.isDirectory = deps.isDirectory ?? ((p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false));
    this.checkTimeoutMs = deps.checkTimeoutMs ?? SPAWN_CHECK_TIMEOUT_MS;
    this.retryMinMs = deps.retryMinMs ?? RETRY_MIN_MS;
    this.refusalCoalesceMs = deps.refusalCoalesceMs ?? SPAWN_REFUSAL_COALESCE_MS;
  }

  /** One spawn envelope from an authenticated peer. Never waits on a decision. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    const state = env.link?.state;
    if (env.linkVersion !== 0) return { ok: false, error: 'bad-request' };
    if (state === 'spawn-result') {
      const result = parseSpawnResult(env.spawnResult);
      if (!result || result.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
      this.takeResult(peer.hostId, result);
      return { ok: true, duplicate: false };
    }
    if (state === 'spawn-targets') {
      const targets = parseSpawnTargets(env.spawnTargets);
      if (!targets || env.linkId !== SPAWN_TARGETS_LINK_ID) return { ok: false, error: 'bad-request' };
      if (targets.version > (this.targetsVersion.get(peer.hostId) ?? -1)) {
        this.targetsVersion.set(peer.hostId, targets.version);
        this.deps.onTargets?.(peer.hostId, targets);
      }
      return { ok: true, duplicate: false };
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

  /** Settle every decision in flight (tests). Retries waiting on a timer are not waited for. */
  async idle(): Promise<void> {
    while (this.deciding.size > 0) await Promise.all([...this.deciding.values()]);
  }

  stop(): void {
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
  }

  // --- B: requests --------------------------------------------------------------

  private receive(hostId: HostId, req: A2aSpawnRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // A request already here is answered from what was stored, whatever the
    // policy or the clock says now: the asker may have lost the first answer.
    const known = this.deps.requests.get(hostId, req.spawnId);
    if (known) {
      if (known.fingerprint !== spawnFingerprint(req)) return { ok: false, error: 'conflict' };
      this.resume(known);
      return { ok: true, duplicate: true };
    }

    // A request refused here is not stored: a PC that may not ask cannot
    // grow this PC's files. Its resend is refused the same way again.
    const policy = this.deps.policy.get();
    let refused: A2aSpawnCode | undefined;
    if (!spawnHostAllowed(policy, hostId)) refused = 'not-allowed';
    else if (!spawnClockOk(sentAt, req.expiresAt, this.now())) refused = 'expired';
    else if (this.deps.requests.pendingCount(hostId) >= SPAWN_PENDING_PER_HOST_MAX) refused = 'rate-limited';
    if (refused) return this.refuse(hostId, req.spawnId, refused);

    let got: ReturnType<SpawnReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request from ${hostId} not stored: ${errMsg(err)}`);
      return { ok: false, error: 'unavailable' };
    }
    if (got.kind === 'conflict') return { ok: false, error: 'conflict' };
    if (got.kind === 'duplicate') {
      this.resume(got.rec);
      return { ok: true, duplicate: true };
    }
    if (got.kind === 'full') return this.refuse(hostId, req.spawnId, 'rate-limited');
    this.deps.log('info', `[a2a-remote] spawn request ${req.spawnId} from ${hostId}: agent ${req.agent}, root ${req.folder.root}`);
    this.scheduleDecide(hostId, req.spawnId);
    return { ok: true, duplicate: false };
  }

  /**
   * Answer a request that is not stored. At most one answer per code per PC
   * per `SPAWN_REFUSAL_COALESCE_MS`, so refused requests cannot fill the
   * outbox; one that could not be queued is `unavailable`, and resent.
   */
  private refuse(hostId: HostId, spawnId: string, code: A2aSpawnCode): A2aRemoteDeliverResponse {
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    const k = `${hostId}:${code}`;
    const last = this.refusedAt.get(k);
    if (last !== undefined && this.now() - last < this.refusalCoalesceMs) return { ok: true, duplicate: false };
    if (!this.sendResult(hostId, { v: 1, spawnId, code })) return { ok: false, error: 'unavailable' };
    this.refusedAt.set(k, this.now());
    return { ok: true, duplicate: false };
  }

  /** A request already stored: send its outcome again, or make sure it is being decided. */
  private resume(rec: SpawnRequestRecordV1): void {
    if (rec.state === 'decided') this.sendDecided(rec);
    else this.scheduleDecide(rec.hostId, rec.spawnId);
  }

  private sendDecided(rec: SpawnRequestRecordV1): void {
    if (!rec.code) return;
    if (!this.sendResult(rec.hostId, { v: 1, spawnId: rec.spawnId, code: rec.code })) return;
    try {
      this.deps.requests.markSent(rec.hostId, rec.spawnId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${rec.spawnId} from ${rec.hostId}: sent, not marked: ${errMsg(err)}`);
    }
  }

  private scheduleDecide(hostId: HostId, spawnId: string, attempt = 0): void {
    const k = `${hostId}:${spawnId}`;
    if (this.deciding.has(k) || (attempt === 0 && this.retries.has(k))) return;
    this.retries.delete(k);
    const run = (async () => {
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
      this.settle(hostId, spawnId, code);
    })().finally(() => this.deciding.delete(k));
    this.deciding.set(k, run);
  }

  /** An unexpected error: the request stays pending and is tried again, until it expires. */
  private retryLater(hostId: HostId, spawnId: string, attempt: number, err: unknown): void {
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    if (this.now() > Date.parse(rec.expiresAt)) {
      this.settle(hostId, spawnId, 'expired');
      return;
    }
    const delay = Math.min(this.retryMinMs * 2 ** attempt, RETRY_MAX_MS);
    this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: deciding failed, trying again in ${Math.round(delay / 1000)}s: ${errMsg(err)}`);
    const k = `${hostId}:${spawnId}`;
    const t = setTimeout(() => {
      this.retries.delete(k);
      this.scheduleDecide(hostId, spawnId, attempt + 1);
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
    if (!(await this.bounded(this.agentInstalled(req.agent)))) return 'agent-not-installed';
    const root = policy.roots.find((r) => r.id === req.folder.root);
    if (!root || !(await this.folderInside(root.path, req.folder.sub ?? ''))) return 'folder-not-allowed';
    // The checks above wait on the disk and the PATH: the human may have
    // turned this PC (or that root, or that agent) off meanwhile.
    const now = this.deps.policy.get();
    if (!spawnHostAllowed(now, hostId)) return 'not-allowed';
    if (!now.agents.includes(req.agent) || !now.roots.some((r) => r.id === root.id && r.path === root.path)) return 'not-allowed';
    return 'not-supported';
  }

  /**
   * `sub` below `rootPath` stays inside it once every link is resolved, and is
   * a folder. The root itself must still resolve to the path stored when it
   * was added: a root replaced by a link elsewhere is refused. The realpaths
   * are compared as they are (no case folding: on a case-sensitive volume a
   * sibling that differs only by case is another folder). The folder is
   * resolved again after the directory check, so a swap in between is seen.
   * Whatever starts an agent later checks again right before it does.
   */
  private async folderInside(rootPath: string, sub: string): Promise<boolean> {
    const target = (rootReal: string): string => (sub ? path.join(rootReal, ...sub.split('/')) : rootReal);
    let rootReal: string;
    let real: string;
    try {
      rootReal = await this.bounded(this.realpath(rootPath));
      real = await this.bounded(this.realpath(target(rootReal)));
    } catch (err) {
      if (err instanceof CheckTimeout) throw err;
      return false;
    }
    if (!samePath(rootReal, rootPath) || !inside(rootReal, real)) return false;
    if (!(await this.bounded(this.isDirectory(real)))) return false;
    let again: string;
    try {
      again = await this.bounded(this.realpath(target(rootReal)));
    } catch (err) {
      if (err instanceof CheckTimeout) throw err;
      return false;
    }
    return again === real;
  }

  /** `p`, or a `CheckTimeout` once it has taken longer than one check may. */
  private bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeout('check timed out')), this.checkTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private settle(hostId: HostId, spawnId: string, code: A2aSpawnCode): void {
    // The PC was removed (its requests forgotten) while this was decided: nothing goes back.
    const rec = this.deps.requests.get(hostId, spawnId);
    if (!rec || rec.state !== 'pending') return;
    let decided: SpawnRequestRecordV1 | undefined;
    try {
      decided = isFinalSpawnCode(code) ? this.deps.requests.decide(hostId, spawnId, code) : undefined;
    } catch (err) {
      // Not stored: the request stays pending, so a resend or a restart decides it again.
      this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: outcome not stored: ${errMsg(err)}`);
      return;
    }
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    if (decided) this.sendDecided(decided);
    else this.sendResult(hostId, { v: 1, spawnId, code });
  }

  /** Queue a result; false when the outbox would not take it. */
  private sendResult(hostId: HostId, result: A2aSpawnResultV1): boolean {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: result.spawnId,
        linkVersion: 0,
        messageId: `res-${result.spawnId}-${result.code}`,
        kind: 'link',
        link: { state: 'spawn-result', version: 0 },
        spawnResult: result,
        sentAt: new Date(this.now()).toISOString(),
      });
      return true;
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn result ${result.spawnId} to ${hostId} not queued: ${errMsg(err)}`);
      return false;
    }
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
