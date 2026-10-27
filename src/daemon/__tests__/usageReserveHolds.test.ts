import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUsageReserveHolds, parseUsageReserveHolds, saveUsageReserveHolds, usageReserveHoldAt } from '../usageReserveHolds';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('usage reserve holds (daemon)', () => {
  it('keeps the pushed holds across a restart; a passed reset holds nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-reserve-holds-'));
    dirs.push(dir);
    const holds = parseUsageReserveHolds([{ account: 'default', untilMs: 2_000 }, { account: 'acct-1', untilMs: 500 }]);
    if (!holds) throw new Error('parse');
    await saveUsageReserveHolds(dir, holds);
    const back = loadUsageReserveHolds(dir);
    expect(usageReserveHoldAt(back, 'default', 1_000)).toBe(2_000);
    expect(usageReserveHoldAt(back, 'acct-1', 1_000)).toBeNull();
    expect(usageReserveHoldAt(back, 'other', 1_000)).toBeNull();
  });

  it('refuses a malformed push whole', () => {
    expect(parseUsageReserveHolds({})).toBeNull();
    expect(parseUsageReserveHolds([{ account: '', untilMs: 1 }])).toBeNull();
    expect(parseUsageReserveHolds([{ account: 'a', untilMs: 'soon' }])).toBeNull();
    expect(parseUsageReserveHolds([])).toEqual(new Map());
  });
});
