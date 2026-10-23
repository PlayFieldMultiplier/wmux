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
import type { SpawnRequestStore } from './spawnRequestStore';
import { errMsg } from './storeFile';

/**
 * Remote spawn, the transport side (both roles; see `shared/a2aSpawn.ts`).
 *
 * Receiving a request (this PC is B): only cheap checks run before the
 * answer, which is `ok` for anything readable. A request that fails one is
 * stored already decided; one that passes is stored pending and decided
 * right after. Either way its outcome goes back as a `spawn-result` envelope
 * through this PC's own outbox, so it reaches A whichever side joined, and
 * nothing that waits ever holds up the transport.
 *
 * Order of the checks, so a PC that may not ask learns nothing else:
 *   1. this PC opted in (feature on, host allowed)  else `not-allowed`
 *   2. B's clock window (`spawnClockOk`)              else `expired`
 *   3. room (pending per PC, records kept)            else `rate-limited`
 *   -- answered `ok` here; then, decided:
 *   4. the agent is on B's list                       else `agent-not-allowed`
 *   5. the agent is installed                         else `agent-not-installed`
 *   6. the root is listed, still resolves to itself,
 *      and root + sub stays inside it, as a folder    else `folder-not-allowed`
 *   7. nothing starts a spawn in this build           `not-supported`
 *
 * Receiving a result or targets (this PC is A): read, handed on, `ok`.
 */

/** Pending requests one PC may have here at once. */
export const SPAWN_PENDING_PER_HOST_MAX = 3;

export interface SpawnReceiverDeps {
  policy: Pick<SpawnPolicyStore, 'get'>;
  requests: Pick<SpawnRequestStore, 'get' | 'receive' | 'decide' | 'pending' | 'pendingCount'>;
  /** Queue an envelope to `hostId` (the delivery outbox). */
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  /** Whether this PC can run `agent` (its launcher on the login PATH). */
  agentInstalled?: (agent: AgentSlug) => Promise<boolean>;
  realpath?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
  /** A spawn result or targets arrived from `hostId` (this PC asked). */
  onResult?: (hostId: HostId, result: A2aSpawnResultV1) => void;
  onTargets?: (hostId: HostId, targets: A2aSpawnTargetsV1) => void;
  now?: () => number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

type SpawnEnvelopeState = 'spawn' | 'spawn-result' | 'spawn-targets';

export function isSpawnEnvelope(env: A2aRemoteEnvelope): env is A2aRemoteEnvelope & { link: { state: SpawnEnvelopeState } } {
  const s = env.kind === 'link' ? env.link?.state : undefined;
  return s === 'spawn' || s === 'spawn-result' || s === 'spawn-targets';
}

export class A2aSpawnReceiver {
  private readonly deps: SpawnReceiverDeps;
  private readonly now: () => number;
  private readonly agentInstalled: (agent: AgentSlug) => Promise<boolean>;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly isDirectory: (p: string) => Promise<boolean>;
  /** Decisions in flight, by host:spawnId, so one is never decided twice at once. */
  private readonly deciding = new Map<string, Promise<void>>();

  constructor(deps: SpawnReceiverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.agentInstalled = deps.agentInstalled ?? agentOnPath;
    this.realpath = deps.realpath ?? ((p) => fs.promises.realpath(p));
    this.isDirectory = deps.isDirectory ?? ((p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false));
  }

  /** One spawn envelope from an authenticated peer. Never waits on a decision. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    const state = env.link?.state;
    if (env.linkVersion !== 0) return { ok: false, error: 'bad-request' };
    if (state === 'spawn-result') {
      const result = parseSpawnResult(env.spawnResult);
      if (!result || result.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
      this.deps.onResult?.(peer.hostId, result);
      return { ok: true, duplicate: false };
    }
    if (state === 'spawn-targets') {
      const targets = parseSpawnTargets(env.spawnTargets);
      if (!targets || env.linkId !== SPAWN_TARGETS_LINK_ID) return { ok: false, error: 'bad-request' };
      this.deps.onTargets?.(peer.hostId, targets);
      return { ok: true, duplicate: false };
    }
    const parsed = parseSpawnRequest(env.spawn);
    if (!parsed || parsed.spawnId !== env.linkId) return { ok: false, error: 'bad-request' };
    // The prompt reaches a terminal later: control characters and escape sequences go now.
    return this.receive(peer.hostId, { ...parsed, text: sanitizeRemoteMessage(parsed.text) }, env.sentAt);
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

  /** Decide whatever is still pending (after a restart). */
  recover(): void {
    for (const rec of this.deps.requests.pending()) this.scheduleDecide(rec.hostId, rec.spawnId);
  }

  /** Settle every decision in flight (tests). */
  async idle(): Promise<void> {
    while (this.deciding.size > 0) await Promise.all([...this.deciding.values()]);
  }

  // --- internals --------------------------------------------------------------

  private receive(hostId: HostId, req: A2aSpawnRequestV1, sentAt: string): A2aRemoteDeliverResponse {
    // A request refused by a cheap check is not stored: a PC that may not ask
    // cannot grow this PC's files. Its resend is refused the same way again.
    const policy = this.deps.policy.get();
    let refused: A2aSpawnCode | undefined;
    if (!spawnHostAllowed(policy, hostId)) refused = 'not-allowed';
    else if (!spawnClockOk(sentAt, req.expiresAt, this.now())) refused = 'expired';
    else if (this.deps.requests.get(hostId, req.spawnId) === undefined && this.deps.requests.pendingCount(hostId) >= SPAWN_PENDING_PER_HOST_MAX) refused = 'rate-limited';
    if (refused) {
      this.deps.log('info', `[a2a-remote] spawn request ${req.spawnId} from ${hostId}: ${refused}`);
      this.sendResult(hostId, { v: 1, spawnId: req.spawnId, code: refused });
      return { ok: true, duplicate: false };
    }

    let got: ReturnType<SpawnReceiverDeps['requests']['receive']>;
    try {
      got = this.deps.requests.receive(hostId, req);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request from ${hostId} not stored: ${errMsg(err)}`);
      return { ok: false, error: 'unavailable' };
    }
    if (got.kind === 'conflict') return { ok: false, error: 'conflict' };
    if (got.kind === 'duplicate') return { ok: true, duplicate: true };
    if (got.kind === 'full') {
      this.sendResult(hostId, { v: 1, spawnId: req.spawnId, code: 'rate-limited' });
      return { ok: true, duplicate: false };
    }
    this.deps.log('info', `[a2a-remote] spawn request ${req.spawnId} from ${hostId}: agent ${req.agent}, root ${req.folder.root}`);
    this.scheduleDecide(hostId, req.spawnId);
    return { ok: true, duplicate: false };
  }

  private scheduleDecide(hostId: HostId, spawnId: string): void {
    const k = `${hostId}:${spawnId}`;
    if (this.deciding.has(k)) return;
    const run = (async () => {
      let code: A2aSpawnCode;
      try {
        code = await this.decide(hostId, spawnId);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: deciding failed: ${errMsg(err)}`);
        code = 'failed';
      }
      this.settle(hostId, spawnId, code);
    })().finally(() => this.deciding.delete(k));
    this.deciding.set(k, run);
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
    if (!(await this.agentInstalled(req.agent))) return 'agent-not-installed';
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
   * was added: a root replaced by a link elsewhere is refused.
   */
  private async folderInside(rootPath: string, sub: string): Promise<boolean> {
    let rootReal: string;
    let real: string;
    try {
      rootReal = await this.realpath(rootPath);
      real = await this.realpath(sub ? path.join(rootReal, ...sub.split('/')) : rootReal);
    } catch {
      return false;
    }
    if (!samePath(rootReal, rootPath)) return false;
    const rel = path.relative(caseFold(rootReal), caseFold(real));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return this.isDirectory(real);
  }

  private settle(hostId: HostId, spawnId: string, code: A2aSpawnCode): void {
    try {
      if (isFinalSpawnCode(code)) this.deps.requests.decide(hostId, spawnId, code);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn request ${spawnId} from ${hostId}: outcome not stored: ${errMsg(err)}`);
    }
    this.deps.log('info', `[a2a-remote] spawn request ${spawnId} from ${hostId}: ${code}`);
    this.sendResult(hostId, { v: 1, spawnId, code });
  }

  private sendResult(hostId: HostId, result: A2aSpawnResultV1): void {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: result.spawnId,
        linkVersion: 0,
        messageId: `res-${result.code}`,
        kind: 'link',
        link: { state: 'spawn-result', version: 0 },
        spawnResult: result,
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn result ${result.spawnId} to ${hostId} not queued: ${errMsg(err)}`);
    }
  }
}

function caseFold(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
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
