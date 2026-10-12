// The verdict store on a real tmp dir: append-only per head, FAILs kept,
// stale heads pruned on write, and an unreadable file is an error, not empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrVerdictStore } from '../prVerdictStore';
import { PR_VERDICT_RETENTION_MS, type PrVerdictRecord } from '../../../shared/prVerdict';

const HEAD = 'a'.repeat(40);
const rec = (over: Partial<PrVerdictRecord> = {}): PrVerdictRecord => ({
  version: 1, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
  principal: { workspaceId: 'ws-v', ptyId: 'pty-v', agent: 'claude' }, summary: 'ok', at: 1_000, ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pr-verdicts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('PrVerdictStore', () => {
  it('creates nothing until a verdict is recorded; a missing file reads empty', async () => {
    const store = new PrVerdictStore(dir);
    expect(await store.list('github.com/o/r', 7)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('appends: a later PASS never replaces an earlier FAIL at the same head', async () => {
    const store = new PrVerdictStore(dir, () => 2_000);
    await store.record(rec({ verdict: 'fail', at: 1_000 }));
    await store.record(rec({ verdict: 'pass', at: 1_500 }));
    await store.record(rec({ prNumber: 8 }));
    await store.record(rec({ repoKey: 'github.com/o/other' }));
    expect((await store.list('github.com/o/r', 7)).map((r) => r.verdict)).toEqual(['fail', 'pass']);
  });

  it('prunes a head whose newest record is past retention, whole', async () => {
    let now = 1_000;
    const store = new PrVerdictStore(dir, () => now);
    await store.record(rec({ headSha: 'b'.repeat(40), verdict: 'fail', at: 1_000 }));
    await store.record(rec({ verdict: 'fail', at: 1_000 }));
    now = 1_000 + PR_VERDICT_RETENTION_MS + 1;
    // A fresh PASS keeps its head's old FAIL; the other head goes.
    await store.record(rec({ verdict: 'pass', at: now }));
    expect((await store.list('github.com/o/r', 7)).map((r) => `${r.headSha[0]}:${r.verdict}`)).toEqual(['a:fail', 'a:pass']);
  });

  it('an unreadable or invalid file throws and is never overwritten', async () => {
    const store = new PrVerdictStore(dir);
    const file = path.join(dir, 'pr-verdicts.json');
    fs.writeFileSync(file, '{not json');
    await expect(store.list('github.com/o/r', 7)).rejects.toThrow();
    await expect(store.record(rec())).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, verdicts: [{ ...rec(), verdict: 'maybe' }] }));
    await expect(store.list('github.com/o/r', 7)).rejects.toThrow('invalid verdict entry');
  });

  it('reads every time from disk (no cache)', async () => {
    const a = new PrVerdictStore(dir);
    const b = new PrVerdictStore(dir);
    expect(await a.list('github.com/o/r', 7)).toEqual([]);
    await b.record(rec({ verdict: 'fail', at: Date.now() }));
    expect((await a.list('github.com/o/r', 7)).map((r) => r.verdict)).toEqual(['fail']);
  });

  it('with no primary, the last committed generation (.bak) is read', async () => {
    const store = new PrVerdictStore(dir);
    const file = path.join(dir, 'pr-verdicts.json');
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ version: 1, verdicts: [rec({ verdict: 'fail' })] }));
    expect((await store.list('github.com/o/r', 7)).map((r) => r.verdict)).toEqual(['fail']);
  });
});
