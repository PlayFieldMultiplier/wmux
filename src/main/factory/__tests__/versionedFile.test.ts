// Versioned factory files: another version is refused, a crash that left only
// the write's backup is recovered, and the fan-out receipts survive a reload.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilePersister, persisterWritesSettled, readVersionedFile } from '../versionedFile';
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

describe('createFilePersister.settled', () => {
  it('waits for every write scheduled so far, the newest snapshot included, and never rejects', async () => {
    const f = path.join(dir, 'p.json');
    let n = 0;
    const p = createFilePersister(f, () => ({ version: 1, n }));
    n = 1;
    void p.schedule();
    n = 2;
    void p.schedule();
    await p.settled();
    expect(readVersionedFile(f, 1)).toEqual({ version: 1, n: 2 });
    // A write that fails (its folder is a file) settles too.
    const bad = createFilePersister(path.join(f, 'under-a-file.json'), () => ({ version: 1 }));
    void bad.schedule().catch(() => undefined);
    await expect(bad.settled()).resolves.toBeUndefined();
  });
});

describe('persisterWritesSettled', () => {
  it('waits for every persister\'s fire-and-forget write, and one scheduled while it waits', async () => {
    const a = createFilePersister(path.join(dir, 'a.json'), () => ({ version: 1, n: 1 }));
    let second: ReturnType<typeof createFilePersister> | null = null;
    void a.schedule().then(() => {
      second = createFilePersister(path.join(dir, 'b.json'), () => ({ version: 1, n: 2 }));
      void second.schedule();
    });
    await persisterWritesSettled();
    expect(readVersionedFile(path.join(dir, 'a.json'), 1)).toMatchObject({ n: 1 });
    expect(second).not.toBeNull();
    expect(readVersionedFile(path.join(dir, 'b.json'), 1)).toMatchObject({ n: 2 });
  });

  it('a failed write settles too', async () => {
    const p = createFilePersister(path.join(dir, 'missing', 'deeper', 'x.json'), () => ({ version: 1 }));
    void p.schedule().catch(() => undefined);
    await expect(persisterWritesSettled()).resolves.toBeUndefined();
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
