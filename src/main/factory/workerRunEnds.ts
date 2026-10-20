// ─── Where a bot worker's run ends in its bot's worker time ────────────────
//
// Worker time counts until the worker is confirmed stopped, not until its
// task's row ends (owner decision 2026-10-21): a worker that reported, or
// whose task ended, may still run until its stop.
//
// What says a worker no longer runs is the holder set (workerHolders.ts),
// the one every live-worker cap and the bot status read: a holder is free
// once its worker was stopped (the reclaim's record), its agent was seen gone
// (a read of the daemon's sessions, an agent-gone fact), its workspace closed,
// or its verdict recorded; anything it cannot tell counts as held. On every
// look at the holders (holderChangeNotice), each run still open whose task
// holds nothing ends then. So a run ends however its worker stopped (the
// reclaim, the owner's stop, an agent that exited by itself) and whatever
// was missed while the app was closed, and never while its worker may run.
// The reclaim's own confirmed stop ends it at that moment too
// (recordWorkerStateChange); a run never ends twice.
//
// Without a holder set (the worker lifecycle host not started) nothing would
// end a run, so the row's end ends it, as it always did (bot.rpc.ts).

import type { LedgerEntry } from '../../shared/ledger';
import type { BotUsage } from './budget';
import { recordWorkerEnd } from './budget';
import type { WorkerHolder } from './workerHolders';

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

/** End, at `at`, every open run whose task holds nothing now: a holder of
 *  it that is free, or none at all while its row has ended. A task with no
 *  row yet (a fan-out between its booking and its register) is left open.
 *  Returns how many runs it ended. */
export function endRunsOfFreeTasks(ports: RunEndPorts, holders: readonly WorkerHolder[], at: number): number {
  const state = new Map<string, WorkerHolder['state']>();
  for (const h of holders) if (state.get(h.taskId) !== 'held') state.set(h.taskId, h.state === 'free' ? 'free' : 'held');
  const done = (taskId: string): boolean => {
    const s = state.get(taskId);
    if (s) return s === 'free';
    const status = ports.row(taskId)?.status;
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  };
  let ended = 0;
  for (const botId of ports.bots()) {
    const open = ports.usageOf(botId).workers.filter((w) => w.endedAt === undefined && done(w.taskId)).map((w) => w.taskId);
    if (open.length === 0) continue;
    ports.mutateUsage(botId, (u) => {
      for (const taskId of open) if (recordWorkerEnd(u, taskId, at)) ended++;
    });
  }
  return ended;
}
