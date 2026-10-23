import type { AutomationRunNowResult } from '../../../shared/automation';

export interface MissedRunNowApi {
  runNow: (id: string, kind: 'manual') => Promise<AutomationRunNowResult>;
}

export interface MissedRunNowOutcome {
  started: number;
  /** Run now results the daemon skipped (an overlap), for their reason. */
  skipped: Extract<AutomationRunNowResult, { ok: true }>['run'][];
  failed: number;
}

/**
 * Run now for the missed-while-asleep notice: each affected schedule runs once,
 * however many of its occurrences were missed. Several runs of one schedule
 * back to back would only overlap, and the overlap rule would skip them.
 * Sequential, in the order they were first missed; one failure does not stop
 * the rest.
 */
export async function runMissedNow(automationIds: readonly string[], api: MissedRunNowApi): Promise<MissedRunNowOutcome> {
  const out: MissedRunNowOutcome = { started: 0, skipped: [], failed: 0 };
  for (const id of automationIds) {
    try {
      const r = await api.runNow(id, 'manual');
      if (!r.ok) out.failed += 1;
      else if (r.run.state === 'skipped') out.skipped.push(r.run);
      else out.started += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
