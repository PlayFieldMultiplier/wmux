import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../claude/UsageApi';
import { UsageTrailStore } from '../usageTrailStore';

const T0 = Date.UTC(2026, 9, 27, 12);
const snap: UsageSnapshot = {
  sessionPct: 20, sessionResetEpochSec: Math.floor(T0 / 1000) + 3600,
  weeklyPct: 5, weeklyResetEpochSec: Math.floor(T0 / 1000) + 86400, fetchedAtMs: T0,
};

const quiet = (): void => undefined;
const dirs: string[] = [];
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-trail-'));
  dirs.push(dir);
  return path.join(dir, 'usage-trail.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('UsageTrailStore', () => {
  it('flushes to disk and reloads the same samples', () => {
    const file = tmpFile();
    const store = new UsageTrailStore(file, { now: () => T0, log: quiet });
    store.record('default', snap);
    store.flushSync();
    const again = new UsageTrailStore(file, { now: () => T0 + 1000, log: quiet });
    expect(again.read('default')).toEqual([{ t: T0, s5: 20, r5: snap.sessionResetEpochSec, s7: 5, r7: snap.weeklyResetEpochSec }]);
  });

  it('starts empty on a corrupt or unknown-version file', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not json');
    expect(new UsageTrailStore(file, { now: () => T0, log: quiet }).read('default')).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ v: 2, trails: {} }));
    expect(new UsageTrailStore(file, { now: () => T0, log: quiet }).read('default')).toEqual([]);
  });
});
