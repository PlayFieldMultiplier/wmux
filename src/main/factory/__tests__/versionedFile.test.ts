// Versioned factory files: another version is refused, a crash that left only
// the write's backup is recovered, and the fan-out receipts survive a reload.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readVersionedFile } from '../versionedFile';
import { BotFanoutReceipts, RECEIPT_RETAIN_MS } from '../botFanoutReceipts';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-vfile-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readVersionedFile', () => {
  it('missing → null; another version or garbage → throws', () => {
    const f = path.join(dir, 'x.json');
    expect(readVersionedFile(f, 1)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ version: 2 }));
    expect(() => readVersionedFile(f, 1)).toThrow(/version/);
    fs.writeFileSync(f, '{not json');
    expect(() => readVersionedFile(f, 1)).toThrow(/unreadable/);
  });

  it('recovers from the backup when the primary is gone', () => {
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(`${f}.bak`, JSON.stringify({ version: 1, items: [1] }));
    expect(readVersionedFile(f, 1)).toEqual({ version: 1, items: [1] });
  });
});

describe('BotFanoutReceipts', () => {
  it('persists keys and drops ones past retention', async () => {
    let now = 1_000;
    const f = path.join(dir, 'keys.json');
    const r = new BotFanoutReceipts(f, () => now);
    r.add('k1');
    await r.flush();
    now += RECEIPT_RETAIN_MS / 2;
    const again = new BotFanoutReceipts(f, () => now);
    again.load();
    expect(again.has('k1')).toBe(true);
    now += RECEIPT_RETAIN_MS;
    again.add('k2');
    expect(again.has('k1')).toBe(false);
    await again.flush();
  });
});
