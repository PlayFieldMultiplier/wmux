import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '../../claude/UsageApi';
import { RESERVE_THRESHOLD_PCT, UsageReserve, reserveUntilMs, usageReserveRefusalText, type UsageReserveHold } from '../usageReserve';

const NOW = Date.UTC(2026, 9, 27, 12);
const RESET_SEC = Math.floor(NOW / 1000) + 2 * 3600;

function snap(sessionPct: number, sessionResetEpochSec = RESET_SEC): UsageSnapshot {
  return { sessionPct, sessionResetEpochSec, weeklyPct: 10, weeklyResetEpochSec: RESET_SEC + 86400, fetchedAtMs: NOW };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function reserve(readings: Array<[string, UsageSnapshot | null]>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-reserve-'));
  dirs.push(dir);
  const pushed: UsageReserveHold[][] = [];
  const told: Array<[string, number]> = [];
  const r = new UsageReserve({
    wmuxDir: dir,
    snapshots: () => readings,
    accountOfWorkspace: (ws) => (ws === 'ws-bound' ? 'acct-1' : 'default'),
    push: (holds) => { pushed.push(holds); },
    notify: (account, untilMs) => told.push([account, untilMs]),
    now: () => NOW,
  });
  return { r, pushed, told, dir };
}

describe('reserveUntilMs', () => {
  it('holds at the threshold until the 5h reset; unknown or passed usage never holds', () => {
    expect(reserveUntilMs(snap(RESERVE_THRESHOLD_PCT), NOW)).toBe(RESET_SEC * 1000);
    expect(reserveUntilMs(snap(RESERVE_THRESHOLD_PCT - 1), NOW)).toBeNull();
    expect(reserveUntilMs(null, NOW)).toBeNull();
    expect(reserveUntilMs(snap(99, 0), NOW)).toBeNull(); // reset unknown
    expect(reserveUntilMs(snap(99, Math.floor(NOW / 1000) - 1), NOW)).toBeNull(); // window already reset
  });
});

describe('UsageReserve', () => {
  it('holds nothing while off; once on, holds the right account and pushes only on change', async () => {
    const { r, pushed } = reserve([['default', snap(90)], ['acct-1', snap(20)]]);
    expect(r.holdForWorkspace('ws-any')).toBeNull();
    r.refresh();
    expect(pushed).toEqual([]);
    await r.setEnabled(true);
    expect(r.holdForWorkspace('ws-any')).toEqual({ account: 'default', untilMs: RESET_SEC * 1000 });
    expect(r.holdForWorkspace('ws-bound')).toBeNull();
    expect(pushed).toEqual([[{ account: 'default', untilMs: RESET_SEC * 1000 }]]);
    r.refresh();
    expect(pushed).toHaveLength(1);
    r.pushNow();
    expect(pushed).toHaveLength(2);
  });

  it('keeps the setting across a restart and tells the owner once per hold', async () => {
    const first = reserve([]);
    await first.r.setEnabled(true);
    const again = new UsageReserve({ wmuxDir: first.dir, snapshots: () => [], accountOfWorkspace: () => 'default' });
    expect(again.enabled()).toBe(true);
    first.r.noteHeld('default', RESET_SEC * 1000);
    first.r.noteHeld('default', RESET_SEC * 1000);
    first.r.noteHeld('acct-1', RESET_SEC * 1000);
    expect(first.told).toEqual([['default', RESET_SEC * 1000], ['acct-1', RESET_SEC * 1000]]);
  });

  it('a relaunch with no readings yet keeps the last hold until its reset, instead of clearing it', async () => {
    const first = reserve([['default', snap(90)]]);
    await first.r.setEnabled(true);
    first.r.refresh();
    await vi.waitFor(() => {
      expect(JSON.parse(fs.readFileSync(path.join(first.dir, 'usage-reserve.json'), 'utf8')).holds).toHaveLength(1);
    }, { timeout: 5_000 });
    const pushed: UsageReserveHold[][] = [];
    const relaunched = new UsageReserve({
      wmuxDir: first.dir,
      snapshots: () => [['default', null]],
      accountOfWorkspace: () => 'default',
      push: (holds) => { pushed.push(holds); },
      now: () => NOW,
    });
    relaunched.pushNow();
    expect(pushed).toEqual([[{ account: 'default', untilMs: RESET_SEC * 1000 }]]);
    expect(relaunched.holdForWorkspace('ws-any')).toEqual({ account: 'default', untilMs: RESET_SEC * 1000 });
  });

  it('sends again a push the daemon did not take', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-reserve-'));
    dirs.push(dir);
    const sent: UsageReserveHold[][] = [];
    let take = false;
    const r = new UsageReserve({
      wmuxDir: dir,
      snapshots: () => [['default', snap(90)]],
      accountOfWorkspace: () => 'default',
      push: async (holds) => { sent.push(holds); return take; },
      now: () => NOW,
    });
    await r.setEnabled(true);
    await new Promise((res) => setImmediate(res));
    take = true;
    r.refresh(); // not taken before, so not skipped as unchanged
    await new Promise((res) => setImmediate(res));
    r.refresh(); // taken now: unchanged
    expect(sent).toHaveLength(2);
  });

  it('says why a fan-out did not start, and where the switch is', () => {
    const text = usageReserveRefusalText(NOW + 90 * 60_000, NOW, false);
    expect(text).toContain(new Date(NOW + 90 * 60_000).toISOString());
    expect(text).toMatch(/last 15%/);
    expect(text).toMatch(/Settings > Claude integration > Usage reserve/);
  });
});
