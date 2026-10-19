// A pane's creation is recorded before its agent starts. The fan-out's
// in-memory launch check is lost on desktop restart, so recover its unfinished
// initial working ledger rows from owned panes and fresh daemon evidence.
import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import type { LedgerEntry } from '../../shared/ledger';
import type { LaunchPresenceReading } from '../../daemon/launchPresence';
import type { WorkerSessionInfo } from './workerReclaim';
import type { WorkerSlots } from './workerSlots';

export const INTERRUPTED_WORKER_STARTUP = 'Startup was interrupted and no worker is running. Inspect the task pane before retrying; it was not restarted automatically.';

export interface WorkerLaunchRecoveryPorts {
  ledger: Pick<TaskLedger, 'list' | 'get' | 'update'>;
  launches: Pick<WorkerSlots, 'launchOf' | 'panesOf' | 'beganInThisRun' | 'leaseRecovery'>;
  /** daemon.listSessions with withRecovery:true; old/unknown replies are not evidence. */
  readSessions(): Promise<unknown>;
  readPresence(ptyId: string, probeProcess: boolean): Promise<unknown>;
  changed?(): void;
  log?(message: string): void;
}

function presenceReading(value: unknown): LaunchPresenceReading | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  return typeof r.incarnationId === 'string' && r.incarnationId.length > 0
    && Number.isSafeInteger(r.inputRevision) && Number(r.inputRevision) >= 0
    && Number.isSafeInteger(r.outputBytes) && Number(r.outputBytes) >= 0
    ? value as LaunchPresenceReading : null;
}

export function createWorkerLaunchRecovery(ports: WorkerLaunchRecoveryPorts): { pass(): Promise<number>; dispose(): void } {
  const candidates = new Map<string, { gen: number; rev: number; botId: string; ownerWorkspaceId: string }>();
  for (const row of ports.ledger.list()) {
    const launch = ports.launches.launchOf(row.id);
    const botId = row.dispatch?.origin.kind === 'bot' ? row.dispatch.origin.botId : undefined;
    if (row.status !== 'working' || row.rev !== 1 || !botId || !launch
      || launch.origin !== 'bot' || launch.botId !== botId || launch.ownerWorkspaceId !== row.ownerWorkspaceId
      || launch.state === 'released' || ports.launches.beganInThisRun(row.id, launch.gen)) continue;
    candidates.set(row.id, { gen: launch.gen, rev: row.rev, botId, ownerWorkspaceId: row.ownerWorkspaceId });
  }
  let active = true;
  let running = false;
  const current = (id: string, candidate: NonNullable<ReturnType<typeof candidates.get>>): LedgerEntry | null => {
    const row = ports.ledger.get(id);
    const launch = ports.launches.launchOf(id);
    return row?.status === 'working' && row.rev === candidate.rev
      && row.ownerWorkspaceId === candidate.ownerWorkspaceId
      && row.dispatch?.origin.kind === 'bot' && row.dispatch.origin.botId === candidate.botId
      && launch?.gen === candidate.gen && launch.state !== 'released'
      && launch.origin === 'bot' && launch.botId === candidate.botId && launch.ownerWorkspaceId === candidate.ownerWorkspaceId
      && !ports.launches.beganInThisRun(id, candidate.gen) ? row : null;
  };
  return {
    async pass() {
      if (!active || running || candidates.size === 0) return 0;
      running = true;
      let failed = 0;
      try {
        const reply = await ports.readSessions() as { sessions?: WorkerSessionInfo[]; recoveryDone?: unknown } | null;
        // An older daemon's bare list and an unfinished recovery cannot
        // establish that these are all the sessions that survived the restart.
        if (!active || !reply || reply.recoveryDone !== true || !Array.isArray(reply.sessions)
          || !reply.sessions.every((s) => s && typeof s.id === 'string')) return 0;
        const sessions = new Map(reply.sessions.map((s) => [s.id, s]));
        if (sessions.size !== reply.sessions.length) return 0;
        for (const [id, candidate] of candidates) {
          if (!active) break;
          if (!current(id, candidate)) { candidates.delete(id); continue; }
          const panes = ports.launches.panesOf(id, candidate.gen);
          // Only this generation's recorded panes count; a workspace's other
          // tabs cannot prove the worker is absent. A missing pane is unknown.
          // Multiple panes need one atomic observation across them. Until
          // that exists, do not retain an early absence across another probe.
          if (panes.length !== 1 || !sessions.has(panes[0])) continue;
          if (panes.some((ptyId) => sessions.get(ptyId)?.agentProcessAlive === true)) {
            candidates.delete(id);
            continue;
          }
          if (panes.some((ptyId) => sessions.get(ptyId)?.commandRunning === true || sessions.get(ptyId)?.exec)) continue;
          const ptyId = panes[0];
          const before = presenceReading(await ports.readPresence(ptyId, true).catch(() => null));
          if (before?.presence === 'running') candidates.delete(id);
          // WSL marker-only absence is not process evidence. Old daemons
          // without the session/input/output witness remain unknown too.
          // A delivered line may still be queued while shell startup runs
          // builtins with no child process. Only zero input proves that this
          // incarnation cannot execute an already-delivered launch later.
          if (!active || before?.presence !== 'absent' || before.reason !== 'idle-shell' || before.inputRevision !== 0) continue;
          let release: (() => void) | undefined;
          try {
            const result = await ports.ledger.update({ id, status: 'failed', expectedRev: candidate.rev,
              actor: { kind: 'system', workspaceId: candidate.ownerWorkspaceId }, summary: INTERRUPTED_WORKER_STARTUP }, async () => {
              // This runs inside the ledger queue, after any earlier write.
              // Re-read the witness now, then lease the exact generation so a
              // relaunch cannot begin while the ledger append is in flight.
              const after = presenceReading(await ports.readPresence(ptyId, false).catch(() => null));
              const nowPanes = ports.launches.panesOf(id, candidate.gen);
              if (!active || !after || after.presence !== 'unknown' || after.reason !== 'not-probed'
                || after.incarnationId !== before.incarnationId || after.inputRevision !== before.inputRevision || after.outputBytes !== before.outputBytes
                || !current(id, candidate) || nowPanes.length !== 1 || nowPanes[0] !== ptyId) return false;
              release = ports.launches.leaseRecovery(id, candidate.gen) ?? undefined;
              return release !== undefined;
            });
            if (result.ok && !result.noop) {
              candidates.delete(id);
              failed++;
              ports.changed?.();
            }
          } finally { release?.(); }
        }
      } catch (error) {
        ports.log?.(`[factory] worker startup recovery: ${String(error)}`);
      } finally {
        running = false;
      }
      return failed;
    },
    dispose() { active = false; candidates.clear(); },
  };
}
