import crypto from 'node:crypto';
import path from 'node:path';
import {
  A2A_SPAWN_RPC,
  normalizeSpawnSub,
  spawnFirstMessageId,
  type A2aSpawnFollowUpCardV1,
  type A2aSpawnRequestV1,
  type A2aSpawnVerdict,
  type A2aSpawnWork,
} from '../../shared/a2aSpawn';
import { isHostId, type A2aLinkRecordV1, type HostId } from '../../shared/a2aRemote';
import { A2A_REMOTE_INBOUND_EVENT, remoteWorkspaceId, type A2aRemoteInboundEvent, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { A2aTaskService } from '../a2a/A2aTaskService';
import type { ExposureStore } from './exposureStore';
import { remoteTaskId } from './ids';
import type { LinkStore } from './linkStore';
import type { SpawnLinkStore } from './spawnLinkStore';
import type { SpawnPolicyStore } from './spawnPolicyStore';
import type { A2aSpawnReceiver } from './spawnReceiver';
import type { SpawnRequestRecordV1 } from './spawnRequestStore';
import { errMsg, isSafeId } from './storeFile';

/**
 * Remote spawn on the receiving PC (B), once main has started the agent:
 * what makes it reachable from the asking PC, and what the link it gets
 * means for as long as it lives.
 *
 * `mint` (the receiver calls it from `started`):
 *   1. picks a fresh link id (a uuid nothing the asker sent predicts; it is
 *      told the id in the `started` answer);
 *   2. shows the new pane to that PC, unless it was shown already;
 *   3. records the link in `spawn-links.json` (before the link exists, so a
 *      link a start made is never without its put-back);
 *   4. creates the link, active at once and marked `spawned`
 *      (`LinkStore.createSpawned`): this PC takes new tasks from the asker's
 *      pane on it, and sends none;
 *   5. queues the prompt as the link's first inbound task (`first_<id>`),
 *      delivered like any remote task: typed into the pane once its agent is
 *      ready, never on a command line.
 *   Anything that fails undoes what this call made. A start that fails later
 *   (its `started` answer not stored, a restart, a start that never reported
 *   back) ends the link again through `abandon`.
 *
 * On a spawn link (`isSpawnLink`): outgoing text is redacted and no images go
 * either way (outbound.ts, inbound.ts); with `followUps: 'ask'` each later
 * task waits for its card (`held: 'awaiting-approval'`).
 *
 * When the link ends (`onLinkTransition`; `reconcile` on start and
 * periodically): the exposure the start added is put back, unless another
 * live link to that PC still uses the pane (then when that one ends), and the
 * record goes. The pane keeps running, owned by this PC's person.
 */

export interface SpawnStarterDeps {
  links: Pick<LinkStore, 'get' | 'list' | 'createSpawned' | 'revoke'>;
  spawnLinks: Pick<SpawnLinkStore, 'get' | 'has' | 'list' | 'add' | 'remove'>;
  exposures: Pick<ExposureStore, 'addPane' | 'removePane' | 'isPaneExposed'>;
  taskService: Pick<A2aTaskService, 'createTask' | 'listRemoteHeld'>;
  policy: Pick<SpawnPolicyStore, 'get'>;
  hostName: (hostId: HostId) => string | undefined;
  /** Display alias of a link's remote pane (`linkAlias`). */
  aliasFor: (link: A2aLinkRecordV1) => string;
  localWorkspaceName?: (workspaceId: string) => string | undefined;
  broadcast: (event: A2aRemoteInboundEvent) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
}

const TERMINAL_LINK: ReadonlySet<string> = new Set(['revoked', 'broken']);

export class A2aSpawnStarter {
  private readonly deps: SpawnStarterDeps;
  private readonly now: () => number;

  constructor(deps: SpawnStarterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * A link a remote start made here: marked so on the link itself, or (a
   * file an older build rewrote without the mark) still recorded here.
   */
  isSpawnLink(linkId: string): boolean {
    return this.deps.links.get(linkId)?.spawned === true || this.deps.spawnLinks.has(linkId);
  }

  /** A new task on this link waits for its card. */
  holdsFollowUps(linkId: string): boolean {
    return this.isSpawnLink(linkId) && this.deps.policy.get().followUps === 'ask';
  }

  /** Live links remote starts made here: of `hostId`, or of every PC. */
  liveCount(hostId?: HostId): number {
    return this.deps.spawnLinks.list().filter((r) => {
      if (hostId !== undefined && r.hostId !== hostId) return false;
      const link = this.deps.links.get(r.linkId);
      return link !== undefined && !TERMINAL_LINK.has(link.state);
    }).length;
  }

  async mint(rec: SpawnRequestRecordV1, request: A2aSpawnRequestV1, end: { workspaceId: string; paneId: string }): Promise<{ linkId: string; linkVersion: number }> {
    if (!isSafeId(end.workspaceId) || !isSafeId(end.paneId)) throw new Error('the started pane is not named');
    const { hostId, spawnId } = rec;
    // A fresh id nothing the asker sent predicts, free in both stores before anything is written.
    let linkId = crypto.randomUUID();
    while (this.deps.links.get(linkId) || this.deps.spawnLinks.has(linkId)) linkId = crypto.randomUUID();
    const policy = this.deps.policy.get();
    const root = policy.roots.find((r) => r.id === request.folder.root);
    const sub = normalizeSpawnSub(request.folder.sub) ?? '';
    const folder = root ? (sub ? path.join(root.path, ...sub.split('/')) : root.path) : '';

    const shown = this.deps.exposures.isPaneExposed(hostId, end.workspaceId, end.paneId);
    const added = shown ? { added: false, addedWorkspace: false } : this.deps.exposures.addPane(hostId, end.workspaceId, end.paneId);
    let recorded = false;
    let link: A2aLinkRecordV1;
    try {
      this.deps.spawnLinks.add({
        v: 1, linkId, hostId, spawnId, workspaceId: end.workspaceId, paneId: end.paneId, agent: request.agent,
        rootId: request.folder.root, folder, addedExposure: added.added, addedWorkspace: added.addedWorkspace,
        startedAt: new Date(this.now()).toISOString(),
      });
      recorded = true;
      link = this.deps.links.createSpawned({
        linkId,
        local: { kind: 'pane', workspaceId: end.workspaceId, paneId: end.paneId },
        remote: { hostId, kind: 'pane', workspaceId: request.from.workspaceId, paneId: request.from.paneId },
        allow: { inbound: true, outbound: false },
        proposer: 'remote',
      });
    } catch (err) {
      // Only what this call made goes again.
      if (recorded) this.forget(linkId);
      if (added.added) this.unexpose(hostId, end, added.addedWorkspace);
      throw err;
    }

    const messageId = spawnFirstMessageId(linkId);
    const taskId = remoteTaskId(linkId, messageId);
    let created: Awaited<ReturnType<SpawnStarterDeps['taskService']['createTask']>>;
    try {
      created = await this.deps.taskService.createTask(
        {
          id: taskId,
          title: request.text.split('\n', 1)[0].slice(0, 100),
          from: { workspaceId: remoteWorkspaceId(linkId), name: this.deps.aliasFor(link) },
          to: { workspaceId: end.workspaceId, name: this.deps.localWorkspaceName?.(end.workspaceId) ?? end.workspaceId, paneId: end.paneId },
          history: [{ kind: 'message', messageId, role: 'user', parts: [{ kind: 'text', text: request.text }] }],
          remote: { v: 1, linkId, hostId, messageId, direction: 'inbound', delivered: false, kind: 'pane' },
        },
        { conflictOnBodyMismatch: true },
      );
    } catch (err) {
      created = { ok: false, error: errMsg(err) } as typeof created;
    }
    if (!created.ok) {
      // The agent runs but would never get its prompt: end the link (its
      // transition puts the exposure back) rather than leave it half made.
      this.endLink(linkId, spawnId);
      throw new Error(`the prompt was not queued: ${created.error}`);
    }
    this.deps.broadcast({ type: A2A_REMOTE_INBOUND_EVENT, taskId });
    return { linkId, linkVersion: link.version };
  }

  /**
   * A start that did not finish: end the link it made, if any (its
   * transition puts the exposure back and drops the record).
   */
  abandon(hostId: HostId, spawnId: string): void {
    for (const rec of this.deps.spawnLinks.list()) {
      if (rec.hostId === hostId && rec.spawnId === spawnId) this.endLink(rec.linkId, spawnId);
    }
  }

  /**
   * Any link ended: put back what spawn links that ended showed. Not only
   * this one: a put-back that waited for another live link to let go of the
   * pane is done now, and one whose write failed is tried again.
   */
  onLinkTransition(link: A2aLinkRecordV1): void {
    if (TERMINAL_LINK.has(link.state)) this.reconcile();
  }

  /**
   * Spawn links that ended (or vanished): put back their exposure and drop
   * them. On start, on every link ending, and periodically, so a put-back
   * that could not be done or written is retried.
   */
  reconcile(): void {
    for (const rec of this.deps.spawnLinks.list()) {
      const link = this.deps.links.get(rec.linkId);
      if (!link || TERMINAL_LINK.has(link.state)) this.end(rec.linkId);
    }
  }

  private endLink(linkId: string, spawnId: string): void {
    const link = this.deps.links.get(linkId);
    try {
      if (link && !TERMINAL_LINK.has(link.state)) this.deps.links.revoke(linkId, 'local');
      else this.reconcile();
    } catch (err) {
      this.deps.log('error', `[a2a-remote] spawn ${spawnId}: link ${linkId} not ended: ${errMsg(err)}`);
    }
  }

  /** Later instructions held for their card, with what the card shows. */
  followUpCards(): A2aSpawnFollowUpCardV1[] {
    const policy = this.deps.policy.get();
    const out: A2aSpawnFollowUpCardV1[] = [];
    for (const task of this.deps.taskService.listRemoteHeld()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (!marker || marker.direction !== 'inbound' || marker.held !== 'awaiting-approval') continue;
      const rec = this.deps.spawnLinks.get(marker.linkId);
      if (!rec) continue;
      const text = (task.history[0]?.parts ?? []).flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n');
      out.push({
        taskId: task.id,
        hostId: rec.hostId,
        hostName: this.deps.hostName(rec.hostId) || rec.hostId.slice(0, 8),
        agent: rec.agent,
        folder: rec.folder,
        permissionMode: policy.permissionMode,
        text,
      });
    }
    return out;
  }

  private end(linkId: string): void {
    const rec = this.deps.spawnLinks.get(linkId);
    if (!rec) return;
    if (rec.addedExposure) {
      const inUse = this.deps.links.list().some(
        (l) => !TERMINAL_LINK.has(l.state) && l.linkId !== linkId && l.remote.hostId === rec.hostId &&
          l.local.kind === 'pane' && l.local.workspaceId === rec.workspaceId && l.local.paneId === rec.paneId,
      );
      // Not put back while another live link still uses the pane: the record stays until that one ends too.
      if (inUse) return;
      if (!this.unexpose(rec.hostId, rec, rec.addedWorkspace)) return;
    }
    this.forget(linkId);
  }

  /** False when the write failed (the pane is hidden in memory; the next start tries again). */
  private unexpose(hostId: HostId, end: { workspaceId: string; paneId: string }, dropWorkspace: boolean): boolean {
    try {
      this.deps.exposures.removePane(hostId, end.workspaceId, end.paneId, dropWorkspace);
      return true;
    } catch (err) {
      this.deps.log('error', `[a2a-remote] pane ${end.paneId} hidden from ${hostId} in memory only: ${errMsg(err)}`);
      return false;
    }
  }

  private forget(linkId: string): void {
    try {
      this.deps.spawnLinks.remove(linkId);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] spawn link ${linkId}: record not removed: ${errMsg(err)}`);
    }
  }
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

const VERDICTS: ReadonlySet<string> = new Set<A2aSpawnVerdict>(['once', 'always', 'deny']);

/** The machine-local RPCs main drives a received request with (`wmux.internal`). */
export function registerSpawnStartRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  deps: { receiver: A2aSpawnReceiver; starter: A2aSpawnStarter },
): void {
  const ids = (p: Record<string, unknown>): { hostId: HostId; spawnId: string } | null => {
    const hostId = p['hostId'];
    const spawnId = p['spawnId'];
    return isHostId(hostId) && typeof spawnId === 'string' && spawnId.length > 0 && spawnId.length <= 64 ? { hostId, spawnId } : null;
  };
  const bad = { ok: false, error: 'bad-request' } as const;
  onRpc(A2A_SPAWN_RPC.work, async (): Promise<A2aSpawnWork> => ({ ...deps.receiver.work(), followUps: deps.starter.followUpCards() }));
  onRpc(A2A_SPAWN_RPC.decide, async (p) => {
    const id = ids(p);
    const verdict = p['verdict'];
    if (!id || typeof verdict !== 'string' || !VERDICTS.has(verdict)) return bad;
    return deps.receiver.decideCard(id.hostId, id.spawnId, verdict as A2aSpawnVerdict);
  });
  onRpc(A2A_SPAWN_RPC.claim, async (p) => {
    const id = ids(p);
    return id ? deps.receiver.claim(id.hostId, id.spawnId) : bad;
  });
  onRpc(A2A_SPAWN_RPC.started, async (p) => {
    const id = ids(p);
    const workspaceId = p['workspaceId'];
    const paneId = p['paneId'];
    if (!id || !isSafeId(workspaceId) || !isSafeId(paneId)) return bad;
    return deps.receiver.started(id.hostId, id.spawnId, { workspaceId, paneId });
  });
  onRpc(A2A_SPAWN_RPC.failed, async (p) => {
    const id = ids(p);
    const code = p['code'];
    if (!id || (code !== 'folder-not-allowed' && code !== 'failed')) return bad;
    return deps.receiver.failed(id.hostId, id.spawnId, code);
  });
}
