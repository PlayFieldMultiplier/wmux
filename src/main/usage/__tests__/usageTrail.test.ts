import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../claude/UsageApi';
import { validateUsageTrailParams } from '../../pipe/handlers/usage.rpc';
import { MAX_KEYS, MAX_SAMPLES_PER_KEY, RETENTION_MS, TAIL_REPLACE_MS, UsageTrail } from '../usageTrail';

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 27, 12);
const R5 = Math.floor(T0 / 1000) + 3 * 3600;
const R7 = Math.floor(T0 / 1000) + 5 * 86400;

function snap(s5: number, s7 = 10, r5 = R5, r7 = R7): UsageSnapshot {
  return { sessionPct: s5, sessionResetEpochSec: r5, weeklyPct: s7, weeklyResetEpochSec: r7, fetchedAtMs: 0 };
}

describe('UsageTrail.record', () => {
  it('skips no-value and unchanged readings, and replaces the tail within the slot', () => {
    const trail = new UsageTrail();
    expect(trail.record('a', null, T0)).toBe(false);
    expect(trail.record('a', snap(10), T0)).toBe(true);
    expect(trail.record('a', snap(10), T0 + MIN)).toBe(false);
    expect(trail.record('a', snap(12), T0 + 2 * MIN)).toBe(true);
    // Replacing does not move the slot, so steady rises still open a new sample every slot.
    expect(trail.record('a', snap(13), T0 + 4 * MIN)).toBe(true);
    expect(trail.record('a', snap(14), T0 + TAIL_REPLACE_MS + MIN)).toBe(true);
    expect(trail.read('a').map((s) => [s.t - T0, s.s5])).toEqual([
      [4 * MIN, 13],
      [TAIL_REPLACE_MS + MIN, 14],
    ]);
  });

  it('never swallows a reset edge or a drop', () => {
    const trail = new UsageTrail();
    trail.record('a', snap(90), T0);
    trail.record('a', snap(0, 10, R5 + 5 * 3600), T0 + MIN); // 5h window rolled over
    trail.record('a', snap(2, 10, R5 + 5 * 3600), T0 + 2 * MIN); // right after an edge: appends
    trail.record('a', snap(1, 10, R5 + 5 * 3600), T0 + 3 * MIN); // a drop: appends
    trail.record('a', snap(3, 10, R5 + 5 * 3600), T0 + 4 * MIN); // after the drop: appends
    expect(trail.read('a').map((s) => s.s5)).toEqual([90, 0, 2, 1, 3]);
  });

  it('treats resets within the merge slack as one window, and survives a clock step back', () => {
    const trail = new UsageTrail();
    trail.record('a', snap(10), T0);
    // HTTP parses the ISO reset a second off the statusline's integer: same window.
    expect(trail.record('a', snap(10, 10, R5 - 1, R7 + 1), T0 + MIN)).toBe(false);
    trail.record('a', snap(11, 10, R5 - 1), T0 + 2 * MIN);
    expect(trail.read('a').map((s) => s.s5)).toEqual([11]);
    // The clock steps back an hour: the next reading opens a slot, never before the tail.
    trail.record('a', snap(12), T0 - 60 * MIN);
    trail.record('a', snap(13), T0 - 59 * MIN);
    expect(trail.read('a').map((s) => [s.s5, s.t >= T0 + 2 * MIN])).toEqual([[11, true], [13, true]]);
  });

  it('keeps retention and the caps', () => {
    const trail = new UsageTrail();
    trail.record('old', snap(5), T0);
    for (let i = 0; i <= MAX_SAMPLES_PER_KEY; i++) trail.record('a', snap(i % 2 ? 50 : 40), T0 + i * MIN);
    expect(trail.read('a')).toHaveLength(MAX_SAMPLES_PER_KEY);
    for (let k = 0; k < MAX_KEYS; k++) trail.record(`k${k}`, snap(1), T0 + 3000 * MIN + k);
    // 'old' was quietest, then 'a'; both leave once the key cap is hit.
    expect(trail.read('old')).toEqual([]);
    expect(trail.read('a')).toEqual([]);
    trail.record('k0', snap(2), T0 + RETENTION_MS + 3001 * MIN);
    expect(Object.keys(trail.toFile(T0 + RETENTION_MS + 3001 * MIN).trails)).toEqual(['k0']);
    expect(trail.read('k0')).toHaveLength(1);
  });

  it('round-trips through its file, dropping malformed samples', () => {
    const trail = new UsageTrail();
    trail.record('a', snap(10), T0);
    const file = trail.toFile(T0);
    (file.trails.a as unknown[]).push({ t: 'x' }, { t: T0 + 1, s5: 101, r5: 0, s7: 0, r7: 0 });
    const back = UsageTrail.fromFile(file, T0 + MIN);
    expect(back.read('a')).toEqual([{ t: T0, s5: 10, r5: R5, s7: 10, r7: R7 }]);
    // A loaded tail is never replaced: the next change appends.
    back.record('a', snap(11), T0 + 2 * MIN);
    expect(back.read('a')).toHaveLength(2);
    expect(back.read('a', T0 + MIN, T0 + 3 * MIN)).toHaveLength(1);
  });
});

describe('validateUsageTrailParams', () => {
  it('accepts a key and an ordered window, rejects anything else', () => {
    expect(validateUsageTrailParams({ account: 'default' })).toEqual({ account: 'default' });
    expect(validateUsageTrailParams({ account: 'a', sinceMs: 1, untilMs: 2 })).toEqual({ account: 'a', sinceMs: 1, untilMs: 2 });
    expect(validateUsageTrailParams({})).toBeNull();
    expect(validateUsageTrailParams({ account: '' })).toBeNull();
    expect(validateUsageTrailParams({ account: 'x'.repeat(129) })).toBeNull();
    expect(validateUsageTrailParams({ account: 'a', sinceMs: -1 })).toBeNull();
    expect(validateUsageTrailParams({ account: 'a', sinceMs: 5, untilMs: 4 })).toBeNull();
  });
});
