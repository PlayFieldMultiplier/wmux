// ─── Where a bot worker's run ends in its bot's worker time ────────────────
//
// Worker time counts until the worker is confirmed stopped, not until its
// task's row ends (owner decision 2026-10-21): a worker that reported, or
// whose task ended, may still run until its stop.
//
// What says a worker no longer runs is the holder set (workerHolders.ts),
// the one every live-worker cap and the bot status read: its holder's
// `workerGone` is set once its worker was stopped (the reclaim's record),
// its agent was seen gone (a read of the daemon's sessions, an agent-gone
// fact) or its workspace closed; a verify verdict frees the slot but not
// the run while its agent may still run; anything it cannot tell counts as
// running. On every look at the holders (holderChangeNotice), each run still
// open whose worker is gone ends, at the record's or fact's time when one
// dates it. So a run ends however its worker stopped (the reclaim, the
// owner's stop, an agent that exited by itself) and whatever was missed
// while the app was closed, and never while its worker may run. The
// reclaim's own confirmed stop ends it at that moment too
// (recordWorkerStateChange); a run never ends twice.
//
// Without a holder set (the worker lifecycle host not started) nothing would
// end a run, so the row's end ends it, as it always did (bot.rpc.ts).

import type { LedgerEntry } from '../../shared/ledger';
import type { BotUsage } from './budget';
import { recordWorkerEnd } from './budget';
import type { LiveHolders, WorkerHolder } from './workerHolders';

let confirmed = false;

/** Set by the worker lifecycle host while its holder set ends the runs. */
export function setWorkerStopsConfirmed(on: boolean): void {
  confirmed = on;
}

/** Whether a worker's run ends once it holds nothing (else at its row's end). */
export function workerStopsConfirmed(): boolean {
  return confirmed;
}

export interface RunEndPorts {
  /** Every bot's id. */
  bots: () => readonly string[];
  usageOf: (botId: string) => BotUsage;
  mutateUsage: (botId: string, fn: (usage: BotUsage) => void) => void;
  /** The task's ledger row, or null when there is none. */
  row: (taskId: string) => Pick<LedgerEntry, 'status'> | null;
}

/** End every open run whose worker the look says is gone: its holder's
 *  `workerGone`, at its time when one dates it (never later than `at`).
 *  A task no holder names is gone only when its row has ended and the look
 *  rests on the open workspaces and a recent read of the daemon's sessions
 *  (before them, a worker still running is not seen yet); a task with no row
 *  yet (a fan-out between its booking and its register) stays open. Returns
 *  how many runs it ended. */
export function endRunsOfGoneWorkers(ports: RunEndPorts, look: LiveHolders, at: number): number {
  const byTask = new Map<string, WorkerHolder>();
  for (const h of look.holders) byTask.set(h.taskId, h);
  const settled = look.workspacesKnown && look.readOk === true;
  const goneAt = (taskId: string): number | null => {
    const h = byTask.get(taskId);
    if (h) return h.workerGone ? Math.min(at, h.workerGone.at ?? at) : null;
    const status = ports.row(taskId)?.status;
    return settled && (status === 'completed' || status === 'cancelled' || status === 'failed') ? at : null;
  };
  let ended = 0;
  for (const botId of ports.bots()) {
    const open: Array<[string, number]> = [];
    for (const w of ports.usageOf(botId).workers) {
      if (w.endedAt !== undefined) continue;
      const when = goneAt(w.taskId);
      if (when !== null) open.push([w.taskId, when]);
    }
    if (open.length === 0) continue;
    ports.mutateUsage(botId, (u) => {
      for (const [taskId, when] of open) if (recordWorkerEnd(u, taskId, when)) ended++;
    });
  }
  return ended;
}
