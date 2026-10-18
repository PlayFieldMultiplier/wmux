// What the agent budget and the fan-out live cap know of the open task
// workspaces' panes (#2387): one read of the workspace mirror and the daemon's
// sessions, at most every `refreshMs` (IdleSnapshot), and the task workspaces
// that hold no live fan-out slot as of that read. Wired by the worker
// lifecycle host; kept apart so the read and its fallback are testable.

import type { LedgerEntry } from '../../shared/ledger';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import { IdleSnapshot, paneRunsNoAgent, paneShowsWork } from './agentSlots';
import { dormantTaskWorkspaceSet, endedTaskAgentRuns, type ReclaimedWorker, type WorkerSessionInfo, type WorkerSessionRecordOf } from './workerReclaim';

/** The ledger-fallback line is not repeated for the same count this soon. */
const FALLBACK_LOG_MS = 60_000;

const isEndedStatus = (status: LedgerEntry['status']): boolean => status === 'completed' || status === 'cancelled' || status === 'failed';

export interface TaskWorkspaceLivenessPorts {
  /** The open workspaces (the workspace mirror), or null before the renderer
   *  pushed its tree. */
  entries: () => WorkspaceListEntry[] | null;
  /** The daemon's sessions; throws when the daemon cannot be read. */
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** The ledger row of a task workspace, and of a task. */
  workspaceRow: (workspaceId: string) => LedgerEntry | null;
  row: (taskId: string) => LedgerEntry | null;
  /** The reclaim records the dormant set reads ([] while the reclaim is off). */
  records: () => readonly ReclaimedWorker[];
  /** The session ids a task's reclaim record holds. */
  recordedSessions: (taskId: string) => string[];
  sessionRecordOf: WorkerSessionRecordOf | undefined;
  refreshMs: number;
  now?: () => number;
  warn?: (line: string) => void;
}

export interface TaskWorkspaceLiveness {
  /** Open workspaces whose panes all run no agent any more (last read). */
  idle: IdleSnapshot;
  /** Open workspaces with a pane at work, as of the last good read. */
  busyWorkspaces: () => ReadonlySet<string>;
  /** Task workspaces that hold no live fan-out slot. */
  dormant: () => ReadonlySet<string>;
  /** Resolves once the last read is no older than `refreshMs` (or failed). */
  refresh: () => Promise<void>;
}

export function createTaskWorkspaceLiveness(ports: TaskWorkspaceLivenessPorts): TaskWorkspaceLiveness {
  const now = ports.now ?? Date.now;
  const warn = ports.warn ?? ((line: string) => console.warn(line));
  let busyWorkspaces: ReadonlySet<string> = new Set();
  // Open task workspaces whose task ended (completed, cancelled, failed: the
  // owner's stop too) with no agent running in them (endedTaskAgentRuns), as
  // of the same read: they hold no live fan-out slot, whether or not the
  // dead-pane sweep closed them yet.
  let endedNoAgentWorkspaces: ReadonlySet<string> = new Set();
  // Open workspaces where an agent is seen running (endedTaskAgentRuns, a
  // silent pane not counted), as of the same read: they hold their slot even
  // when a reclaim record says stopped.
  let agentWorkspaces: ReadonlySet<string> = new Set();
  // Whether a read ever completed. Until one does, nothing above is known.
  let hasGoodRead = false;
  let loggedFallback: { n: number; at: number } | null = null;
  const idle = new IdleSnapshot(async () => {
    // A mirror the renderer has not pushed yet is not "no workspaces open": a
    // read now would hold every ended task as live until the next one, so it
    // fails and is not kept.
    const entries = ports.entries();
    if (!entries) throw new Error('the workspace list is not available yet');
    const byId = new Map((await ports.listSessions()).map((x) => [x.id, x]));
    const next = new Set<string>();
    const busy = new Set<string>();
    const endedNoAgent = new Set<string>();
    const withAgent = new Set<string>();
    for (const e of entries) {
      const ptys = Array.isArray(e.ptyIds) ? e.ptyIds : [];
      if (ptys.some((id) => paneShowsWork(byId.get(id)))) busy.add(e.id);
      // Gone, seen to exit, or respawned by the daemon's restart with no agent
      // since; an agent never attributed otherwise is not known dead.
      if (ptys.length > 0 && ptys.every((id) => paneRunsNoAgent(byId.get(id)))) next.add(e.id);
      const row = ports.workspaceRow(e.id);
      const recorded = row ? ports.recordedSessions(row.id) : [];
      if (endedTaskAgentRuns(ptys, row?.id ?? '', recorded, byId, ports.sessionRecordOf, false)) withAgent.add(e.id);
      else if (row && isEndedStatus(row.status) && !endedTaskAgentRuns(ptys, row.id, recorded, byId, ports.sessionRecordOf)) endedNoAgent.add(e.id);
    }
    busyWorkspaces = busy;
    endedNoAgentWorkspaces = endedNoAgent;
    agentWorkspaces = withAgent;
    hasGoodRead = true;
    return next;
  }, ports.refreshMs, now);

  const dormant = (): ReadonlySet<string> => {
    idle.get();
    const base = { records: ports.records(), row: ports.row, workspaceRow: ports.workspaceRow, agentWorkspaces };
    if (hasGoodRead) return dormantTaskWorkspaceSet({ ...base, endedNoAgent: endedNoAgentWorkspaces });
    // No read of the panes yet (the daemon or the workspace list is not up):
    // the ledger decides. An ended task's workspace holds no slot unless an
    // agent was seen in it; counting it live would refuse fan-outs on tasks
    // that ended long ago.
    const out = dormantTaskWorkspaceSet({ ...base, endedNoAgent: (ports.entries() ?? []).map((e) => e.id) });
    const n = out.size - dormantTaskWorkspaceSet({ ...base, endedNoAgent: [] }).size;
    if (n > 0 && (!loggedFallback || loggedFallback.n !== n || now() - loggedFallback.at >= FALLBACK_LOG_MS)) {
      loggedFallback = { n, at: now() };
      warn(`[fanout] liveness unknown: counting ${n} ended task workspace(s) as dormant from the ledger`);
    }
    return out;
  };

  return { idle, busyWorkspaces: () => busyWorkspaces, dormant, refresh: () => idle.fresh() };
}
