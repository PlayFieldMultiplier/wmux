// ─── Where a bot worker's run ends in its bot's worker time ────────────────
//
// Worker time counts until the worker's agent is confirmed stopped, not until
// its task's row ends (owner decision 2026-10-21): a worker that reported,
// or whose task ended, may still run until its stop. What confirms a stop:
//
//   - the worker reclaim's record reaching `stopped` (an ended task's stop,
//     a reported or idle worker's pause, a dead pane found, a resumed
//     worker's exit): workerLifecycleHost.ts reclaimed.onStateChange;
//   - the owner's stop (factoryStop.ts), which writes no reclaim record:
//     its worker stop answering without an error;
//   - a reported row whose worker's agent a fresh read already finds gone.
//
// Only the worker lifecycle host with its reclaim on confirms stops. Until it
// does (not started, or its record file unreadable), nothing would ever end
// a run, so the row's end ends it, as it always did (bot.rpc.ts).

import type { LedgerEntry } from '../../shared/ledger';
import { getBotStore } from './botStore';
import { recordWorkerEnd } from './budget';
import { endedTaskAgentRuns, isTaskOwnWorkerPane, type WorkerSessionInfo, type WorkerSessionRecordOf } from './workerReclaim';

let confirmed = false;

/** Set by the worker lifecycle host while its reclaim runs. */
export function setWorkerStopsConfirmed(on: boolean): void {
  confirmed = on;
}

/** Whether a worker's run ends at its confirmed stop (else at its row's end). */
export function workerStopsConfirmed(): boolean {
  return confirmed;
}

/** End the task's run in its bot's worker time at `at`; nothing when none
 *  is open (a run never ends twice). */
export function endWorkerRun(botId: string, taskId: string, at: number): void {
  const store = getBotStore();
  if (!botId || !store?.get(botId)) return;
  store.mutateUsage(botId, (u) => {
    recordWorkerEnd(u, taskId, at);
  });
}

export interface ReportedRunPorts {
  /** The daemon's sessions; throws when they cannot be read. */
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** The task's row now. */
  row: (taskId: string) => LedgerEntry | null;
  /** The session ids the task's reclaim record holds. */
  recordedSessions: (taskId: string) => readonly string[];
  sessionRecordOf: WorkerSessionRecordOf | undefined;
  end: (botId: string, taskId: string, at: number) => void;
  now?: () => number;
}

/** A row just reported for review whose worker's agent is already gone (a
 *  worker that exited after its report): its run ends now, not at the
 *  reported worker's idle stop minutes later. Only when a fresh read names
 *  at least one of the task's own worker panes and none runs its agent, and
 *  the row is still the one reported; anything it cannot tell leaves the
 *  run to the confirmed stop. Never rejects. */
export async function endReportedRunIfAgentGone(ports: ReportedRunPorts, entry: LedgerEntry): Promise<boolean> {
  const botId = entry.dispatch?.origin.kind === 'bot' ? entry.dispatch.origin.botId : undefined;
  if (!botId || entry.status !== 'review_requested') return false;
  const at = (ports.now ?? Date.now)();
  let sessions: WorkerSessionInfo[];
  try {
    sessions = await ports.listSessions();
  } catch {
    return false;
  }
  const recorded = ports.recordedSessions(entry.id);
  const own = sessions.filter((x) => isTaskOwnWorkerPane(x, entry.id, recorded, ports.sessionRecordOf)).map((x) => x.id);
  if (own.length === 0) return false;
  if (endedTaskAgentRuns(own, entry.id, recorded, new Map(sessions.map((x) => [x.id, x])), ports.sessionRecordOf)) return false;
  const now = ports.row(entry.id);
  if (!now || now.status !== 'review_requested' || now.rev !== entry.rev) return false;
  ports.end(botId, entry.id, at);
  return true;
}
