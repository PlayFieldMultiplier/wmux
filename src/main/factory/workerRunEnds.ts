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
// its bot's worker time again: a check that sees its holder running after
// a launch newer than its last run's end opens a new run from that launch.
//
// Without a holder set (no worker lifecycle host comes) nothing would end a
// run, so the row's end ends it, as it always did (bot.rpc.ts). The wiring
// says one comes as it registers, before any module starts, so no row end
// in between ends a run early.

import type { LedgerEntry } from '../../shared/ledger';
import type { BotUsage } from './budget';
import { recordWorkerEnd, recordWorkerStart } from './budget';
import type { LiveHolders, WorkerHolder } from './workerHolders';

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
  /** When the task's worker was known stopped, by its durable reclaim
   *  record or agent-gone fact, when one says so. */
  stoppedAt: (taskId: string) => number | undefined;
  /** When the task's worker was last launched, if that launch came up or is
   *  coming up (WorkerSlots.liveLaunchAt). */
  launchedAt: (taskId: string) => number | undefined;
}

/** End every open run whose worker the look says is gone, and open a run
 *  for a worker relaunched since its last one ended. A holder's
 *  `workerGone` ends its run at its time when one dates it (never later
 *  than `at`). A task no holder names is gone only when its row has ended
 *  and the look rests on the open workspaces and a recent read of the
 *  daemon's sessions (before them, a worker still running is not seen yet),
 *  at its durable stop's time when one is known; a task with no row yet (a
 *  fan-out between its booking and its register) stays open. A task whose
 *  holder runs (held, not gone) after a launch newer than its last run's end
 *  gets a new run from that launch. Returns how many runs it ended or
 *  opened. */
export function endRunsOfGoneWorkers(ports: RunEndPorts, look: LiveHolders, at: number): number {
  const byTask = new Map<string, WorkerHolder>();
  for (const h of look.holders) byTask.set(h.taskId, h);
  const settled = look.workspacesKnown && look.readOk === true;
  const goneAt = (taskId: string): number | null => {
    const h = byTask.get(taskId);
    if (h) return h.workerGone ? Math.min(at, h.workerGone.at ?? at) : null;
    const status = ports.row(taskId)?.status;
    if (!settled || (status !== 'completed' && status !== 'cancelled' && status !== 'failed')) return null;
    return Math.min(at, ports.stoppedAt(taskId) ?? at);
  };
  /** A launch to open a new run from: its holder runs, and it came after
   *  the task's last run ended. */
  const relaunchedAt = (taskId: string, lastEnd: number): number | null => {
    const h = byTask.get(taskId);
    if (!h || h.state === 'free' || h.workerGone) return null;
    const launch = ports.launchedAt(taskId);
    return launch !== undefined && launch > lastEnd && launch <= at ? launch : null;
  };
  let moved = 0;
  for (const botId of ports.bots()) {
    const ends: Array<[string, number]> = [];
    const starts: Array<[string, number]> = [];
    const lastEnd = new Map<string, number>();
    const open = new Set<string>();
    for (const w of ports.usageOf(botId).workers) {
      if (w.endedAt === undefined) {
        open.add(w.taskId);
        const when = goneAt(w.taskId);
        if (when !== null) ends.push([w.taskId, when]);
      } else {
        lastEnd.set(w.taskId, Math.max(lastEnd.get(w.taskId) ?? -Infinity, w.endedAt));
      }
    }
    for (const [taskId, end] of lastEnd) {
      if (open.has(taskId)) continue;
      const when = relaunchedAt(taskId, end);
      if (when !== null) starts.push([taskId, when]);
    }
    if (ends.length === 0 && starts.length === 0) continue;
    ports.mutateUsage(botId, (u) => {
      for (const [taskId, when] of ends) if (recordWorkerEnd(u, taskId, when)) moved++;
      for (const [taskId, when] of starts) {
        recordWorkerStart(u, taskId, when, { resumed: true });
        moved++;
      }
    });
  }
  return moved;
}
