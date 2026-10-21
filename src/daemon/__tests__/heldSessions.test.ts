import { describe, it, expect } from 'vitest';
import { HOLD_RESTAMP_MS, stampHeld, suspendedClockMs } from '../heldSessions';
import type { DaemonSession } from '../types';

function suspended(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id: 'sess-held',
    state: 'suspended',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActivity: '2026-10-01T00:00:00.000Z',
    pid: 0,
    cmd: 'bash',
    cwd: '/tmp',
    env: {},
    cols: 80,
    rows: 24,
    deadTtlHours: 24,
    ...overrides,
  };
}

// #2398 — a hold renews a suspended record against the suspended TTL.
describe('held suspended sessions', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');

  it('stamps a suspended record, and asks for a save', () => {
    const record = suspended();
    expect(stampHeld(record, now)).toBe(true);
    expect(record.heldAt).toBe(new Date(now).toISOString());
  });

  it('renews at most once per HOLD_RESTAMP_MS, so a boot of held panes writes once', () => {
    const record = suspended();
    stampHeld(record, now);
    expect(stampHeld(record, now + HOLD_RESTAMP_MS - 1)).toBe(false);
    expect(record.heldAt).toBe(new Date(now).toISOString());
    expect(stampHeld(record, now + HOLD_RESTAMP_MS)).toBe(true);
    expect(record.heldAt).toBe(new Date(now + HOLD_RESTAMP_MS).toISOString());
  });

  it('never stamps a missing or non-suspended record', () => {
    expect(stampHeld(undefined, now)).toBe(false);
    const live = suspended({ state: 'detached' });
    expect(stampHeld(live, now)).toBe(false);
    expect(live.heldAt).toBeUndefined();
  });

  it('measures the suspended TTL from the later of the last activity and the last hold', () => {
    const activity = Date.parse('2026-10-01T00:00:00.000Z');
    expect(suspendedClockMs(suspended())).toBe(activity);
    expect(suspendedClockMs(suspended({ heldAt: new Date(now).toISOString() }))).toBe(now);
    expect(suspendedClockMs(suspended({ heldAt: '2026-09-01T00:00:00.000Z' }))).toBe(activity);
    expect(suspendedClockMs(suspended({ heldAt: 'garbage' }))).toBe(activity);
  });
});
