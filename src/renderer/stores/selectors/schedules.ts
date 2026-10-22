import {
  AUTOMATION_FINAL_RUN_STATES,
  type Automation,
  type AutomationRun,
} from '../../../shared/automation';
import { AUTOMATION_TICK_MS } from '../../../shared/automationSchedule';
import type { SleepWindow } from '../../../shared/sleepPrevention';

type SchedulesState = {
  automations: Automation[];
  automationRuns: AutomationRun[];
  /** The last stretch the system slept through, and whether its notice was answered. */
  sleepWindow?: SleepWindow | null;
  sleepNoticeDismissed?: boolean;
};

/** Newest first: a run's own start, else the occurrence it was scheduled for. */
export function runTime(run: AutomationRun): number {
  return run.startedAt ?? run.scheduledFor;
}

export function sortRunsNewestFirst(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.slice().sort((a, b) => runTime(b) - runTime(a));
}

export function isLiveRun(run: AutomationRun): boolean {
  return !AUTOMATION_FINAL_RUN_STATES.includes(run.state);
}

/** Latest run per automation id. */
export function latestRunByAutomation(runs: readonly AutomationRun[]): Map<string, AutomationRun> {
  const latest = new Map<string, AutomationRun>();
  for (const run of runs) {
    const prev = latest.get(run.automationId);
    if (!prev || runTime(run) > runTime(prev)) latest.set(run.automationId, run);
  }
  return latest;
}

export interface ScheduleNavSummary {
  /** Runs awaiting a human's response — the only amber signal. */
  needs: number;
  /** Enabled schedules whose latest run failed (muted text, not attention). */
  failed: number;
  /** Earliest upcoming occurrence across enabled schedules (ms epoch). */
  nextRunAt: number | null;
}

export interface MissedWhileAsleep {
  /** Occurrences skipped as missed while the system slept. */
  count: number;
  /** The schedules they belong to, each once, in the order first missed. */
  automationIds: string[];
}

const NONE_MISSED: MissedWhileAsleep = { count: 0, automationIds: [] };
let lastMissed: MissedWhileAsleep = NONE_MISSED;

/**
 * Scheduled runs the daemon recorded as missed because the system was asleep
 * at their time: skipped with reason `missed` (not `daemon_down`, which is
 * wmux being closed), scheduled inside the last sleep window, on a schedule
 * that still exists. Read from the run history the daemon keeps, never
 * recomputed: the daemon records them on its first tick after the wake, so
 * this is a selector rather than a count taken at resume. Nothing once the
 * notice was answered.
 *
 * The window opens one scheduler tick before the suspend: a time between the
 * daemon's last tick and the suspend was missed too. A schedule whose
 * catch-up already ran after the wake (planDue fires the newest occurrence
 * still within grace and records the older ones missed) is left out: Run now
 * would run it a second time.
 */
export function selectMissedWhileAsleep(state: SchedulesState): MissedWhileAsleep {
  const window = state.sleepWindow;
  if (!window || state.sleepNoticeDismissed) return NONE_MISSED;
  const known = new Set(state.automations.map((a) => a.id));
  const from = window.suspendedAt - AUTOMATION_TICK_MS;
  const inWindow = state.automationRuns
    .filter((run) => run.state === 'skipped' && run.reason === 'missed' && run.trigger === 'scheduled'
      && known.has(run.automationId)
      && run.scheduledFor >= from && run.scheduledFor <= window.resumedAt);
  const newestMissed = new Map<string, number>();
  for (const run of inWindow) newestMissed.set(run.automationId, Math.max(newestMissed.get(run.automationId) ?? 0, run.scheduledFor));
  const caughtUp = new Set(state.automationRuns
    .filter((run) => run.trigger === 'scheduled' && run.state !== 'skipped' && run.scheduledFor > (newestMissed.get(run.automationId) ?? Infinity))
    .map((run) => run.automationId));
  const missed = inWindow
    .filter((run) => !caughtUp.has(run.automationId))
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
  if (missed.length === 0) return NONE_MISSED;
  const automationIds = [...new Set(missed.map((run) => run.automationId))];
  // The same object while the answer holds: the notice subscribes to this and
  // the store changes on every output chunk.
  const last = lastMissed;
  if (last.count === missed.length && last.automationIds.length === automationIds.length
      && last.automationIds.every((id, i) => id === automationIds[i])) {
    return last;
  }
  lastMissed = { count: missed.length, automationIds };
  return lastMissed;
}

/**
 * The sidebar's Schedules row. "Needs" is runs awaiting a response, plus one
 * for an unanswered missed-while-asleep notice — a
 * failure is not waiting on anyone, and keeping it amber for days would spend
 * the attention budget on history. Failures count separately: every enabled
 * schedule whose LATEST run failed (no ack exists, so it clears on the next
 * outcome or on disabling). Numbers only; the row calls t().
 */
export function selectScheduleNavSummary(state: SchedulesState): ScheduleNavSummary {
  const known = new Set(state.automations.map((a) => a.id));
  let needs = 0;
  for (const run of state.automationRuns) {
    if (run.state === 'awaiting' && known.has(run.automationId)) needs += 1;
  }
  if (selectMissedWhileAsleep(state).count > 0) needs += 1;
  const latest = latestRunByAutomation(state.automationRuns);
  let failed = 0;
  let nextRunAt: number | null = null;
  for (const a of state.automations) {
    if (a.enabled && latest.get(a.id)?.state === 'failed') failed += 1;
    if (a.enabled && a.nextRunAt !== null && (nextRunAt === null || a.nextRunAt < nextRunAt)) {
      nextRunAt = a.nextRunAt;
    }
  }
  return { needs, failed, nextRunAt };
}

/** A non-approval mode the daemon will downgrade: the grant predates an edit. */
export function isPermissionReset(a: Automation): boolean {
  return a.permission.mode !== 'approval' && a.permission.grantedRevision !== a.revision;
}

/** Drafts first (they wait on a human), then by name. */
export function orderSchedules(automations: readonly Automation[]): Automation[] {
  return automations.slice().sort((a, b) => {
    const pa = a.proposed ? 0 : 1;
    const pb = b.proposed ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}
