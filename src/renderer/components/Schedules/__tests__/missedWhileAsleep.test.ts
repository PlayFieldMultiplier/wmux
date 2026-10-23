// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { selectMissedWhileAsleep, selectScheduleNavSummary } from '../../../stores/selectors/schedules';
import { useStore } from '../../../stores';
import { runMissedNow } from '../missedWhileAsleep';
import { automation, run } from './fixtures';
import type { AutomationRunNowResult } from '../../../../shared/automation';

const SLEEP = { suspendedAt: 10_000, resumedAt: 100_000 };

const missed = (id: string, automationId: string, scheduledFor: number) =>
  run({ id, automationId, scheduledFor, state: 'skipped', reason: 'missed', endedAt: SLEEP.resumedAt + 5_000 });

describe('runs missed while asleep', () => {
  const automations = [automation({ id: 'a1' }), automation({ id: 'a2' })];

  it('counts the daemon\'s missed skips scheduled inside the sleep, per schedule', () => {
    const state = {
      automations,
      automationRuns: [
        missed('m1', 'a1', 20_000),
        missed('m2', 'a2', 30_000),
        missed('m3', 'a1', 40_000),
        missed('just-before', 'a2', -10_000), // after the daemon's last tick before the suspend
        missed('before', 'a1', -25_000), // more than a tick before the sleep began
        missed('after', 'a2', 150_000), // after the wake
        run({ id: 'down', automationId: 'a2', scheduledFor: 50_000, state: 'skipped', reason: 'daemon_down' }),
        run({ id: 'overlap', automationId: 'a2', scheduledFor: 50_000, state: 'skipped', reason: 'overlap' }),
        missed('gone', 'deleted', 60_000), // its schedule was removed
      ],
      sleepWindow: SLEEP,
    };
    expect(selectMissedWhileAsleep(state)).toEqual({ count: 4, automationIds: ['a2', 'a1'] });
  });

  it('leaves out a schedule whose catch-up already ran after the wake', () => {
    const automationRuns = [
      missed('m1', 'a1', 20_000),
      missed('m2', 'a1', 40_000),
      // planDue fired the newest occurrence; Run now would run it again.
      run({ id: 'caught-up', automationId: 'a1', scheduledFor: 90_000, state: 'completed' }),
      missed('m3', 'a2', 30_000),
      // A manual run is not a catch-up.
      run({ id: 'manual', automationId: 'a2', trigger: 'manual', scheduledFor: 95_000, state: 'completed' }),
    ];
    expect(selectMissedWhileAsleep({ automations, automationRuns, sleepWindow: SLEEP })).toEqual({ count: 1, automationIds: ['a2'] });
  });

  it('returns the same object while the answer holds', () => {
    const automationRuns = [missed('m1', 'a1', 20_000)];
    const first = selectMissedWhileAsleep({ automations, automationRuns, sleepWindow: SLEEP });
    expect(selectMissedWhileAsleep({ automations: [...automations], automationRuns: [...automationRuns], sleepWindow: SLEEP })).toBe(first);
  });

  it('is nothing without a sleep window, or once the notice was answered', () => {
    const automationRuns = [missed('m1', 'a1', 20_000)];
    expect(selectMissedWhileAsleep({ automations, automationRuns }).count).toBe(0);
    expect(selectMissedWhileAsleep({ automations, automationRuns, sleepWindow: SLEEP, sleepNoticeDismissed: true }).count).toBe(0);
  });

  it('the sidebar row counts an open notice once as needing you', () => {
    const automationRuns = [missed('m1', 'a1', 20_000), missed('m2', 'a2', 30_000)];
    expect(selectScheduleNavSummary({ automations, automationRuns, sleepWindow: SLEEP }).needs).toBe(1);
    expect(selectScheduleNavSummary({ automations, automationRuns, sleepWindow: SLEEP, sleepNoticeDismissed: true }).needs).toBe(0);
  });

  it('Skip answers the notice; the next sleep raises a new one', () => {
    useStore.setState({ automations, automationRuns: [missed('m1', 'a1', 20_000)] });
    useStore.getState().recordSleepWindow(SLEEP);
    expect(selectMissedWhileAsleep(useStore.getState()).count).toBe(1);
    useStore.getState().dismissSleepNotice();
    expect(selectMissedWhileAsleep(useStore.getState()).count).toBe(0);

    useStore.setState({ automationRuns: [...useStore.getState().automationRuns, missed('m2', 'a2', 220_000)] });
    useStore.getState().recordSleepWindow({ suspendedAt: 200_000, resumedAt: 300_000 });
    expect(selectMissedWhileAsleep(useStore.getState())).toEqual({ count: 1, automationIds: ['a2'] });
  });

  it('a second sleep before the notice is answered widens the window', () => {
    useStore.setState({ automations, automationRuns: [missed('m1', 'a1', 20_000), missed('m2', 'a2', 220_000)], sleepWindow: null, sleepNoticeDismissed: false });
    useStore.getState().recordSleepWindow(SLEEP);
    useStore.getState().recordSleepWindow({ suspendedAt: 200_000, resumedAt: 300_000 });
    expect(selectMissedWhileAsleep(useStore.getState())).toEqual({ count: 2, automationIds: ['a1', 'a2'] });
  });

  it('Run now starts each affected schedule once, and reports what did not start', async () => {
    const results: Record<string, AutomationRunNowResult> = {
      a1: { ok: true, run: run({ id: 'n1', automationId: 'a1', trigger: 'manual', state: 'launching' }) },
      a2: { ok: true, run: run({ id: 'n2', automationId: 'a2', trigger: 'manual', state: 'skipped', reason: 'overlap' }) },
      a3: { ok: false, error: 'gone' },
    };
    const runNow = vi.fn(async (id: string) => {
      if (id === 'a4') throw new Error('ipc down');
      return results[id];
    });
    const outcome = await runMissedNow(['a1', 'a2', 'a3', 'a4'], { runNow });
    expect(runNow.mock.calls).toEqual([['a1', 'manual'], ['a2', 'manual'], ['a3', 'manual'], ['a4', 'manual']]);
    expect(outcome.started).toBe(1);
    expect(outcome.skipped.map((r) => r.reason)).toEqual(['overlap']);
    expect(outcome.failed).toBe(2);
  });
});
