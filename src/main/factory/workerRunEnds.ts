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
// A worker relaunched in its own pane (a launch line typed again) runs on
// its bot's worker time again: a check whose read saw its own agent running
// after its last launch and its last run's end opens a new run from that
// read.
//
// Without a holder set (no worker lifecycle host comes) nothing would end a
// run, so the row's end ends it, as it always did (bot.rpc.ts). The wiring
// says one comes as it registers, before any module starts, so no row end
// in between ends a run early.

import type { LedgerEntry } from '../../shared/ledger';
import type { BotUsage } from './budget';
import { recordWorkerEnd, recordWorkerStart } from './budget';
import type { LiveHolders, WorkerHolder } from './workerHolders';

/** The row statuses at which a bot's task no longer needs its worker: the
 *  row-end rule (bot.rpc.ts onWorkerEnded, via fanoutCallerNotify.ts) and
 *  its sweep (endRunsOfEndedRows) both read this one set, so a row the
 *  callback would have ended is never left open by the sweep. */
export const WORKER_ENDED: ReadonlySet<string> = new Set(['review_requested', 'completed', 'failed', 'cancelled']);

let confirmed = false;

/** Set while a worker lifecycle host's holder set ends the runs, or one is
 *  on its way (the wiring, as it registers). */
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
  /** When the task's worker was last known stopped, by its durable reclaim
   *  record or agent-gone fact (the later of them), when one says so. */
  stoppedAt: (taskId: string) => number | undefined;
  /** When the task's worker was last launched, if that launch came up or is
   *  coming up (WorkerSlots.liveLaunchAt). */
  launchedAt: (taskId: string) => number | undefined;
}

/** End every open run whose worker the look says is gone, and open a run
 *  for a worker seen running again after its last one ended. A holder's
 *  `workerGone` ends its run at its time when one dates it (never later
 *  than `at`). A task no holder names is gone only when its row has ended
 *  and the look rests on the open workspaces and a recent read of the
 *  daemon's sessions (before them, a worker still running is not seen yet),
 *  at its durable stop's time when one is known; a task with no row yet (a
 *  fan-out between its booking and its register) stays open. A stop time
 *  older than the run is not its stop: the run ends now instead. A bot
 *  task whose own agent a read saw running, after its last launch and
 *  after its last run ended (or none is kept: older runs are pruned), gets
 *  a new run from that read: a launch line staged and not yet run starts
 *  none. Returns how many runs it ended or opened. */
export function endRunsOfGoneWorkers(ports: RunEndPorts, look: LiveHolders, at: number): number {
  const byTask = new Map<string, WorkerHolder>();
  for (const h of look.holders) byTask.set(h.taskId, h);
  const settled = look.workspacesKnown && look.readOk === true;
  const endOf = (taskId: string, startedAt: number): number | null => {
    const h = byTask.get(taskId);
    let when: number | undefined;
    if (h) {
      if (!h.workerGone) return null;
      when = h.workerGone.at;
    } else {
      const status = ports.row(taskId)?.status;
      if (!settled || (status !== 'completed' && status !== 'cancelled' && status !== 'failed')) return null;
      when = ports.stoppedAt(taskId);
    }
    return when !== undefined && when >= startedAt ? Math.min(at, when) : at;
  };
  let moved = 0;
  // Ends, bot by bot.
  for (const botId of ports.bots()) {
    const ends: Array<[string, number]> = [];
    for (const w of ports.usageOf(botId).workers) {
      if (w.endedAt !== undefined) continue;
      const when = endOf(w.taskId, w.startedAt);
      if (when !== null) ends.push([w.taskId, when]);
    }
    if (ends.length === 0) continue;
    ports.mutateUsage(botId, (u) => {
      for (const [taskId, when] of ends) if (recordWorkerEnd(u, taskId, when)) moved++;
    });
  }
  // Starts: a bot task's own agent seen running again. Whether it runs is
  // the holder's `workerGone`, not its slot: a verify verdict frees the slot
  // of a worker that may still run.
  const readAt = look.readOk === true ? look.readAt : undefined;
  if (readAt === undefined || readAt > at) return moved;
  for (const h of look.holders) {
    if (h.origin !== 'bot' || !h.botId || !h.agentSeen || h.workerGone) continue;
    const launch = ports.launchedAt(h.taskId);
    if (launch === undefined || readAt <= launch) continue;
    const mine = ports.usageOf(h.botId).workers.filter((w) => w.taskId === h.taskId);
    if (mine.some((w) => w.endedAt === undefined)) continue;
    const lastEnd = Math.max(-Infinity, ...mine.map((w) => w.endedAt ?? -Infinity));
    if (readAt <= lastEnd) continue;
    ports.mutateUsage(h.botId, (u) => recordWorkerStart(u, h.taskId, readAt, { resumed: true }));
    moved++;
  }
  return moved;
}

/** End, at `at`, every open run whose task's row has ended: the row-end
 *  rule, for the runs a lifecycle host that was coming and never came up
 *  left open. Returns how many it ended. */
export function endRunsOfEndedRows(ports: Pick<RunEndPorts, 'bots' | 'usageOf' | 'mutateUsage' | 'row'>, at: number): number {
  let ended = 0;
  for (const botId of ports.bots()) {
    const done = ports.usageOf(botId).workers
      .filter((w) => w.endedAt === undefined)
      .map((w) => w.taskId)
      .filter((taskId) => {
        const status = ports.row(taskId)?.status;
        return status !== undefined && WORKER_ENDED.has(status);
      });
    if (done.length === 0) continue;
    ports.mutateUsage(botId, (u) => {
      for (const taskId of done) if (recordWorkerEnd(u, taskId, at)) ended++;
    });
  }
  return ended;
}
