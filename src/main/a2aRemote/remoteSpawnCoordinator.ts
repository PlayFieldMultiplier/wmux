import { agentLauncherStem, agentRow } from '../../shared/agentIdentity';
import { A2A_REMOTE_INBOUND_EVENT, A2A_REMOTE_RPC } from '../../shared/a2aRemoteDelivery';
import {
  A2A_SPAWN_EVENT,
  A2A_SPAWN_RPC,
  type A2aRemoteSpawnedBy,
  type A2aSpawnCardV1,
  type A2aSpawnClaimResult,
  type A2aSpawnFollowUpCardV1,
  type A2aSpawnWork,
} from '../../shared/a2aSpawn';
import type { ApprovalHandle, RemoteSpawnPromptInfo } from '../mcp/ApprovalQueue';
import { createSpawnWorktree, type SpawnWorktreeInput, type SpawnWorktreeResult } from './spawnWorktree';

/**
 * Remote spawn on the receiving PC, the app's part. The daemon decides and
 * keeps every request; this shows the cards and starts what was approved:
 *
 *   awaiting → the approval card (Allow once / Always / Deny) → `decide`
 *   approved → `claim` (the daemon checks everything again) → a hardened
 *              worktree (spawnWorktree.ts) → the "From <PC>" workspace, its
 *              one pane running the agent's launcher alone, in the policy's
 *              permission mode → the depth stamp → `started` (the daemon then
 *              links it and queues the prompt as its first task)
 *   a held follow-up → its card → the hold is retried (delivered) or rejected
 *
 * Driven by the daemon's `a2a.remote.spawn.changed` and inbound broadcasts,
 * on start (every reconnect) and on a backstop, so a lost broadcast only
 * delays. The prompt never reaches a command line, a log or a toast here.
 */

export const REMOTE_SPAWN_BACKSTOP_MS = 30_000;
/** A claim the daemon could not check now is tried again after this. */
export const REMOTE_SPAWN_RETRY_MS = 30_000;
/** How long the renderer may take to open the workspace. */
const SPAWN_WORKSPACE_TIMEOUT_MS = 60_000;

export interface RemoteSpawnCoordinatorDeps {
  daemonRpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sendToRenderer: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  onDaemonEvent: (listener: (event: { type?: unknown; [key: string]: unknown }) => void) => () => void;
  /** The approval queue (kind 'remote-spawn'). */
  consent: {
    requestConsent(input: {
      kind: 'remote-spawn';
      dedupeKey: string;
      clientName: string;
      title: string;
      deadlineAt?: number;
      remoteSpawn: RemoteSpawnPromptInfo;
    }): ApprovalHandle;
    cancelPrompt(promptId: string, reason: string): void;
  };
  /** Deliver a held remote task now (RemoteA2aBridge.retryHeld). */
  retryHeld: (taskId: string) => Promise<unknown>;
  /** Stamp the new workspace so its agent cannot fan out again (depth 1). Throws when it could not. */
  markDepth: (workspaceId: string, owner: string) => void;
  createWorktree?: (input: SpawnWorktreeInput) => Promise<SpawnWorktreeResult>;
  backstopMs?: number;
  retryMs?: number;
  log: (level: 'info' | 'warn', msg: string) => void;
}

type SpawnedWorkspace = { workspaceId: string; paneId: string };

export class RemoteSpawnCoordinator {
  private readonly deps: RemoteSpawnCoordinatorDeps;
  /** Cards on screen, by key: `spawn:<host>:<id>` or `follow:<taskId>`. */
  private readonly shown = new Map<string, string>();
  private readonly starting = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(deps: RemoteSpawnCoordinatorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = this.deps.onDaemonEvent((event) => {
      if (event?.type === A2A_SPAWN_EVENT || event?.type === A2A_REMOTE_INBOUND_EVENT) void this.refresh();
    });
    this.timer = setInterval(() => void this.refresh(), this.deps.backstopMs ?? REMOTE_SPAWN_BACKSTOP_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  /** Read what the daemon has for this app and act on it. One at a time; a call meanwhile runs once more after. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        // eslint-disable-next-line no-await-in-loop -- one pass at a time
        await this.pass();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Resolves once the current pass and the starts it began have finished (tests). */
  async whenIdle(): Promise<void> {
    while (this.running || this.starting.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- until quiet
      await (this.running ?? Promise.resolve());
      // eslint-disable-next-line no-await-in-loop -- a start finishing is a few awaits away
      if (this.starting.size > 0) await new Promise((r) => setImmediate(r));
    }
  }

  private async pass(): Promise<void> {
    if (this.stopped) return;
    let work: A2aSpawnWork;
    try {
      work = (await this.deps.daemonRpc(A2A_SPAWN_RPC.work, {})) as A2aSpawnWork;
    } catch (err) {
      this.deps.log('warn', `[remote-spawn] could not read the requests: ${errText(err)}`);
      return;
    }
    if (!work || !Array.isArray(work.awaiting) || !Array.isArray(work.approved) || !Array.isArray(work.followUps)) return;
    const live = new Set<string>();
    for (const card of work.awaiting) {
      const key = `spawn:${card.hostId}:${card.spawnId}`;
      live.add(key);
      if (!this.shown.has(key)) this.showCard(key, card);
    }
    for (const card of work.followUps) {
      const key = `follow:${card.taskId}`;
      live.add(key);
      if (!this.shown.has(key)) this.showFollowUp(key, card);
    }
    // Decided elsewhere, expired, or the PC was removed: its card goes.
    for (const [key, promptId] of [...this.shown]) {
      if (live.has(key)) continue;
      this.shown.delete(key);
      this.deps.consent.cancelPrompt(promptId, 'this request is no longer waiting');
    }
    for (const item of work.approved) void this.startOne(item.hostId, item.spawnId);
  }

  private showCard(key: string, card: A2aSpawnCardV1): void {
    const handle = this.deps.consent.requestConsent({
      kind: 'remote-spawn',
      dedupeKey: key,
      clientName: card.hostName,
      title: `${card.hostName} wants to start ${card.agent} here`,
      deadlineAt: Date.parse(card.expiresAt),
      remoteSpawn: {
        hostId: card.hostId,
        hostName: card.hostName,
        agent: card.agent,
        folder: card.folder,
        permissionMode: card.permissionMode,
        followUps: card.followUps,
        text: card.text,
      },
    });
    this.shown.set(key, handle.promptId);
    void handle.resolution
      .then(async (r) => {
        const verdict = !r.approved ? 'deny' : r.remember ? 'always' : 'once';
        const res = await this.deps.daemonRpc(A2A_SPAWN_RPC.decide, { hostId: card.hostId, spawnId: card.spawnId, verdict });
        if (!isOk(res)) this.deps.log('warn', `[remote-spawn] ${card.spawnId}: answer not taken: ${errorOf(res)}`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.shown.get(key) === handle.promptId) this.shown.delete(key);
        void this.refresh();
      });
  }

  private showFollowUp(key: string, card: A2aSpawnFollowUpCardV1): void {
    const handle = this.deps.consent.requestConsent({
      kind: 'remote-spawn',
      dedupeKey: key,
      clientName: card.hostName,
      title: `${card.hostName} sent a new instruction`,
      remoteSpawn: {
        hostId: card.hostId,
        hostName: card.hostName,
        agent: card.agent,
        folder: card.folder,
        permissionMode: card.permissionMode,
        followUps: 'ask',
        text: card.text,
        followUp: true,
      },
    });
    this.shown.set(key, handle.promptId);
    void handle.resolution
      .then(async (r) => {
        if (r.approved) await this.deps.retryHeld(card.taskId);
        else await this.deps.daemonRpc(A2A_REMOTE_RPC.rejectHeld, { taskId: card.taskId, reason: 'declined on this PC' });
      })
      .catch((err: unknown) => this.deps.log('warn', `[remote-spawn] follow-up ${card.taskId}: not settled: ${errText(err)}`))
      .finally(() => {
        if (this.shown.get(key) === handle.promptId) this.shown.delete(key);
      });
  }

  private async startOne(hostId: string, spawnId: string): Promise<void> {
    const key = `${hostId}:${spawnId}`;
    if (this.starting.has(key) || this.retryTimers.has(key) || this.stopped) return;
    this.starting.add(key);
    try {
      let claimed: A2aSpawnClaimResult;
      try {
        claimed = (await this.deps.daemonRpc(A2A_SPAWN_RPC.claim, { hostId, spawnId })) as A2aSpawnClaimResult;
      } catch (err) {
        this.retryLater(key, hostId, spawnId, errText(err));
        return;
      }
      if (!claimed?.ok) {
        // Refused (the daemon answered the asker), or not checkable right now.
        if (!claimed?.code) this.retryLater(key, hostId, spawnId, claimed?.error ?? 'no answer');
        return;
      }
      const { claim } = claimed;
      const failed = async (code: 'folder-not-allowed' | 'failed', why: string): Promise<void> => {
        this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: not started (${code}): ${why}`);
        await this.deps.daemonRpc(A2A_SPAWN_RPC.failed, { hostId, spawnId, code }).catch(() => undefined);
      };
      const row = agentRow(claim.agent);
      if (!row) return failed('failed', `unknown agent ${claim.agent}`);
      const tree = await (this.deps.createWorktree ?? createSpawnWorktree)({ repoPath: claim.repoPath, sub: claim.sub, spawnId });
      if (!tree.ok) return failed(tree.code, tree.detail);
      const spawnedBy: A2aRemoteSpawnedBy = { hostId, name: claim.hostName, spawnId, agent: claim.agent };
      let ws: SpawnedWorkspace | null;
      try {
        ws = spawnedWorkspace(await this.deps.sendToRenderer('fanout.spawnWorkspace', {
          name: `From ${claim.hostName}`,
          cwd: tree.cwd,
          // The launcher alone: the prompt arrives as the link's first task, typed in once the agent is ready.
          initialCommand: agentLauncherStem(row),
          workerPermissionMode: claim.permissionMode,
          remoteSpawnedBy: spawnedBy,
        }, { timeoutMs: SPAWN_WORKSPACE_TIMEOUT_MS }));
      } catch (err) {
        return failed('failed', `the workspace did not open: ${errText(err)} (worktree left at ${tree.worktreePath})`);
      }
      if (!ws) return failed('failed', `the workspace did not open (worktree left at ${tree.worktreePath})`);
      try {
        this.deps.markDepth(ws.workspaceId, `remote-spawn:${hostId}`);
      } catch (err) {
        // The agent has no prompt yet; without the stamp it must not get one.
        return failed('failed', `the workspace was not stamped: ${errText(err)}`);
      }
      const res = await this.deps.daemonRpc(A2A_SPAWN_RPC.started, { hostId, spawnId, ...ws });
      if (!isOk(res)) this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: started, not linked: ${errorOf(res)}`);
      else this.deps.log('info', `[remote-spawn] ${spawnId} from ${hostId}: started ${claim.agent} in workspace ${ws.workspaceId}`);
    } catch (err) {
      this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: start failed: ${errText(err)}`);
    } finally {
      this.starting.delete(key);
    }
  }

  private retryLater(key: string, hostId: string, spawnId: string, why: string): void {
    if (this.stopped) return;
    this.deps.log('warn', `[remote-spawn] ${spawnId} from ${hostId}: not claimed now, trying again: ${why}`);
    const t = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.startOne(hostId, spawnId);
    }, this.deps.retryMs ?? REMOTE_SPAWN_RETRY_MS);
    t.unref?.();
    this.retryTimers.set(key, t);
  }
}

function spawnedWorkspace(res: unknown): SpawnedWorkspace | null {
  if (typeof res !== 'object' || res === null) return null;
  const r = res as Record<string, unknown>;
  return typeof r['workspaceId'] === 'string' && r['workspaceId'] && typeof r['paneId'] === 'string' && r['paneId']
    ? { workspaceId: r['workspaceId'], paneId: r['paneId'] }
    : null;
}

function isOk(res: unknown): boolean {
  return typeof res === 'object' && res !== null && (res as { ok?: unknown }).ok === true;
}

function errorOf(res: unknown): string {
  const e = typeof res === 'object' && res !== null ? (res as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : 'no answer';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
