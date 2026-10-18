// What the agent budget and the fan-out live cap know of the open task
// workspaces' panes (#2387, #2393): one read of the workspace mirror and the
// daemon's sessions, at most every `refreshMs` (IdleSnapshot), and the task
// workspaces that hold no live fan-out slot. An ended task's agent seen gone
// by a good read is kept as a durable fact (agentGoneFacts.ts), so a restart
// or a daemon that cannot answer yet never counts it as live again. Wired by
// the worker lifecycle host; kept apart so the read and the facts are testable.

import type { LedgerEntry } from '../../shared/ledger';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import { IdleSnapshot, paneRunsNoAgent, paneShowsWork } from './agentSlots';
import type { AgentGoneFact, AgentGoneFacts } from './agentGoneFacts';
import { dormantTaskWorkspaceSet, endedTaskAgentRuns, type ReclaimedWorker, type WorkerSessionInfo, type WorkerSessionRecordOf } from './workerReclaim';

const isEndedStatus = (status: LedgerEntry['status']): boolean => status === 'completed' || status === 'cancelled' || status === 'failed';

/** One read of the daemon's sessions, and whether its startup recovery had
 *  finished when it answered. */
export interface SessionRead {
  sessions: WorkerSessionInfo[];
  recoveryDone: boolean;
}

/** The answer to `daemon.listSessions` asked with `withRecovery: true`. A
 *  daemon that knows the flag answers `{sessions, recoveryDone}`. An older
 *  one ignores it and answers the bare list: it is taken as recovered, which
 *  is how every read was taken before the flag existed. Throws on anything
 *  else (a failed read, not "no sessions"). Pure. */
export function parseSessionRead(reply: unknown): SessionRead {
  if (Array.isArray(reply)) return { sessions: reply as WorkerSessionInfo[], recoveryDone: true };
  const r = reply as { sessions?: unknown; recoveryDone?: unknown } | null;
  if (r && typeof r === 'object' && Array.isArray(r.sessions)) {
    return { sessions: r.sessions as WorkerSessionInfo[], recoveryDone: r.recoveryDone !== false };
  }
  throw new Error('daemon.listSessions answered no session list');
}

export interface TaskWorkspaceLivenessPorts {
  /** The open workspaces (the workspace mirror), or null before the renderer
   *  pushed its tree. */
  entries: () => WorkspaceListEntry[] | null;
  /** The daemon's sessions; throws when the daemon cannot be read. */
  readSessions: () => Promise<SessionRead>;
  /** The ledger row of a task workspace, and of a task. */
  workspaceRow: (workspaceId: string) => LedgerEntry | null;
  row: (taskId: string) => LedgerEntry | null;
  /** Ended rows that may still hold a slot (the agent budget's catch-up
   *  window): one whose workspace is closed has its panes gone. */
  endedRows: () => readonly LedgerEntry[];
  /** The reclaim records the dormant set reads ([] while the reclaim is off). */
  records: () => readonly ReclaimedWorker[];
  /** The session ids a task's reclaim record holds. */
  recordedSessions: (taskId: string) => string[];
  sessionRecordOf: WorkerSessionRecordOf | undefined;
  /** The durable "agent seen gone" facts (null: none are kept). */
  facts: AgentGoneFacts | null;
  refreshMs: number;
  now?: () => number;
}

export interface TaskWorkspaceLiveness {
  /** Open workspaces whose panes all run no agent any more (last read). */
  idle: IdleSnapshot;
  /** Open workspaces with a pane at work, as of the last good read. */
  busyWorkspaces: () => ReadonlySet<string>;
  /** Task workspaces that hold no live fan-out slot. */
  dormant: () => ReadonlySet<string>;
  /** Ended tasks whose agent is known gone: they hold no agent slot. */
  goneTasks: () => ReadonlySet<string>;
  /** Resolves once the last read is no older than `refreshMs` (or failed). */
  refresh: () => Promise<void>;
}

export function createTaskWorkspaceLiveness(ports: TaskWorkspaceLivenessPorts): TaskWorkspaceLiveness {
  const now = ports.now ?? Date.now;
  const resumed = (taskId: string): boolean => ports.records().find((r) => r.taskId === taskId)?.state === 'resumed';
  let busyWorkspaces: ReadonlySet<string> = new Set();
  // Open task workspaces whose task ended (completed, cancelled, failed: the
  // owner's stop too) with no agent running in them (endedTaskAgentRuns), as
  // of the last good read: they hold no live fan-out slot, whether or not the
  // dead-pane sweep closed them yet. Each is written as a fact, and the
  // facts answer instead of this set when they are kept.
  let endedNoAgentWorkspaces: ReadonlySet<string> = new Set();
  // Open workspaces where an agent is seen running (endedTaskAgentRuns, a
  // silent pane not counted), as of the last good read: they hold their slot
  // even when a reclaim record says stopped or a fact says gone.
  let agentWorkspaces: ReadonlySet<string> = new Set();
  const read = async (): Promise<ReadonlySet<string>> => {
    // A mirror the renderer has not pushed yet, or pushed empty, is not "no
    // workspaces open": a read now would hold every ended task restored next
    // as live until the following read, so it fails and is not kept.
    const entries = ports.entries();
    if (!entries || entries.length === 0) throw new Error('the workspace list is not available yet');
    const reply = await ports.readSessions();
    // While the daemon restores its sessions, a pane still waiting for its
    // WSL distribution reads as suspended (no agent) and the list may be
    // short: that is no proof any agent is gone, so the read fails and
    // writes nothing. Once recovery is done, an empty list is the truth.
    if (!reply.recoveryDone) throw new Error('the daemon is still restoring its sessions');
    const byId = new Map(reply.sessions.map((x) => [x.id, x]));
    const at = now();
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
      if (endedTaskAgentRuns(ptys, row?.id ?? '', recorded, byId, ports.sessionRecordOf, false)) {
        withAgent.add(e.id);
        // Seen running again: the task holds its slot from now on, across a
        // restart too, until a read sees it exit.
        if (row) ports.facts?.clear(row.id, 'an agent was seen running in its workspace');
      } else if (row && isEndedStatus(row.status) && !endedTaskAgentRuns(ptys, row.id, recorded, byId, ports.sessionRecordOf)) {
        endedNoAgent.add(e.id);
        if (!resumed(row.id)) ports.facts?.note({ taskId: row.id, taskWorkspaceId: e.id, sessions: [...ptys], at });
      }
    }
    // An ended task whose workspace is closed: its panes are gone.
    const open = new Set(entries.map((e) => e.id));
    for (const row of ports.endedRows()) {
      if (!isEndedStatus(row.status) || open.has(row.taskWorkspaceId) || resumed(row.id)) continue;
      ports.facts?.note({ taskId: row.id, taskWorkspaceId: row.taskWorkspaceId, sessions: [], at });
    }
    busyWorkspaces = busy;
    endedNoAgentWorkspaces = endedNoAgent;
    agentWorkspaces = withAgent;
    return next;
  };
  const idle = new IdleSnapshot(read, ports.refreshMs, now);

  /** Whether a fact still says what it said: its task's row is still the
   *  one of its workspace, and no pane it does not name opened there since
   *  (a closed workspace has none). Unknown workspaces: it holds. */
  const holds = (f: AgentGoneFact, entries: WorkspaceListEntry[] | null): boolean => {
    const ws = entries?.find((e) => e.id === f.taskWorkspaceId);
    if (!ws) return true;
    if (ports.workspaceRow(f.taskWorkspaceId)?.id !== f.taskId) return false;
    const ptys = Array.isArray(ws.ptyIds) ? ws.ptyIds : [];
    return ptys.every((id) => f.sessions.includes(id));
  };
  const factWorkspaces = (): string[] => {
    const entries = ports.entries();
    return (ports.facts?.all() ?? []).filter((f) => holds(f, entries)).map((f) => f.taskWorkspaceId);
  };

  const dormant = (): ReadonlySet<string> => {
    idle.get();
    // The facts (every ended task a good read saw with no agent is one), or
    // the last good read when none are kept. With no fact for it (a cold
    // start before the first read, a task running at shutdown), an ended
    // task holds its slot: its agent may still run.
    return dormantTaskWorkspaceSet({
      records: ports.records(),
      row: ports.row,
      workspaceRow: ports.workspaceRow,
      endedNoAgent: ports.facts ? factWorkspaces() : endedNoAgentWorkspaces,
      agentWorkspaces,
    });
  };

  const goneTasks = (): ReadonlySet<string> => {
    idle.get();
    const entries = ports.entries();
    const out = new Set<string>();
    for (const f of ports.facts?.all() ?? []) {
      const row = ports.row(f.taskId);
      if (!row || !isEndedStatus(row.status) || resumed(f.taskId) || agentWorkspaces.has(f.taskWorkspaceId) || !holds(f, entries)) continue;
      out.add(f.taskId);
    }
    if (ports.facts) return out;
    for (const ws of endedNoAgentWorkspaces) {
      const row = ports.workspaceRow(ws);
      if (row && isEndedStatus(row.status) && !resumed(row.id)) out.add(row.id);
    }
    return out;
  };

  return { idle, busyWorkspaces: () => busyWorkspaces, dormant, goneTasks, refresh: () => idle.fresh() };
}
