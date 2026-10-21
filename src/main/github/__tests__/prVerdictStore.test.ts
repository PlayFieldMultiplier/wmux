// The verdict store on a real tmp dir: append-only per head, FAILs kept,
// stale heads pruned on write, and an unreadable file is an error, not empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrVerdictStore, onPrVerdictRecorded } from '../prVerdictStore';
import { PR_VERDICT_RETENTION_MS, isPrVerdictRecord, type PrVerdictRecord } from '../../../shared/prVerdict';

const HEAD = 'a'.repeat(40);
const rec = (over: Partial<PrVerdictRecord> = {}): PrVerdictRecord => ({
  version: 1, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
  principal: { workspaceId: 'ws-v', ptyId: 'pty-v', agent: 'claude' }, summary: 'ok', at: 1_000, ...over,
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pr-verdicts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('PrVerdictStore', () => {
  it('tells recorded-listeners about each written record (as v2), never about a refused one', async () => {
    const store = new PrVerdictStore(dir, () => 2_000);
    const seen: PrVerdictRecord[] = [];
    const off = onPrVerdictRecorded((r) => seen.push(r));
    const offThrowing = onPrVerdictRecorded(() => { throw new Error('listener'); });
    try {
      await store.record(rec());
      await expect(store.record({ ...rec(), prNumber: 0 })).rejects.toThrow();
    } finally {
      off();
      offThrowing();
    }
    await store.record(rec({ prNumber: 8 }));
    expect(seen.map((r) => [r.version, r.prNumber])).toEqual([[2, 7]]);
  });

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

  it('prunes a head with no FAIL past retention, whole; a head holding a FAIL never', async () => {
    let now = 1_000;
    const store = new PrVerdictStore(dir, () => now);
    await store.record(rec({ headSha: 'b'.repeat(40), verdict: 'pass', at: 1_000 }));
    await store.record(rec({ verdict: 'fail', at: 1_000 }));
    now = 1_000 + PR_VERDICT_RETENTION_MS + 1;
    await store.record(rec({ headSha: 'c'.repeat(40), at: now }));
    expect((await store.list('github.com/o/r', 7)).map((r) => `${r.headSha[0]}:${r.verdict}`)).toEqual(['a:fail', 'c:pass']);
    // A later PASS at the old FAIL's head still sits beside it.
    await store.record(rec({ verdict: 'pass', at: now }));
    expect((await store.list('github.com/o/r', 7)).filter((r) => r.headSha === HEAD).map((r) => r.verdict)).toEqual(['fail', 'pass']);
  });

  it('a read waits for the appends queued before it', async () => {
    const store = new PrVerdictStore(dir);
    const pending = store.record(rec({ verdict: 'fail', at: Date.now() }));
    const read = store.list('github.com/o/r', 7);
    expect((await read).map((r) => r.verdict)).toEqual(['fail']);
    await pending;
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

  it('an entry another build wrote is skipped on read and kept on write; one that could be a FAIL for the PR still refuses the read', async () => {
    const store = new PrVerdictStore(dir);
    const file = path.join(dir, 'pr-verdicts.json');
    const odd = { ...rec({ verdict: 'pass' }), evidence: { taskId: 'reading-only', gateHeadSha: HEAD, reading: 7 } };
    const otherFail = { ...rec({ verdict: 'fail' }), prNumber: 8, principal: 'garbled' };
    fs.writeFileSync(file, JSON.stringify({ version: 2, verdicts: [rec({ verdict: 'pass', at: Date.now() }), odd, otherFail] }));
    expect((await store.list('github.com/o/r', 7)).map((r) => r.verdict)).toEqual(['pass']);
    await store.record(rec({ verdict: 'pass', at: Date.now() + 1 }));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { verdicts: unknown[] };
    expect(saved.verdicts).toHaveLength(4);
    expect(saved.verdicts).toEqual(expect.arrayContaining([odd, otherFail]));
    // An unreadable entry that may be a FAIL on this PR blocks the read.
    fs.writeFileSync(file, JSON.stringify({ version: 2, verdicts: [rec({ verdict: 'pass' }), { ...rec({ verdict: 'fail' }), principal: 'garbled' }] }));
    await expect(store.list('github.com/o/r', 7)).rejects.toThrow('invalid verdict entry');
    expect((await store.list('github.com/o/r', 9))).toEqual([]);
  });

  it('a reading-only record of any basis is read (the lane decides what it is worth)', async () => {
    const store = new PrVerdictStore(dir);
    const r1 = { ...rec({ verdict: 'pass', at: Date.now() }), version: 2 as const, principal: { workspaceId: 'ws-v', botId: 'bot-0a1b2c3d', agent: 'bot:verifier' },
      evidence: { taskId: 'reading-only', gateHeadSha: HEAD, reading: 'docs-only' } };
    fs.writeFileSync(path.join(dir, 'pr-verdicts.json'), JSON.stringify({ version: 2, verdicts: [r1] }));
    expect(await store.list('github.com/o/r', 7)).toEqual([r1]);
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

describe('verdict records v2', () => {
  const v2 = (over: Partial<PrVerdictRecord> = {}): PrVerdictRecord => ({
    ...rec(), version: 2, principal: { workspaceId: 'ws-v', botId: 'bot-v', agent: 'claude' },
    evidence: { taskId: 'task-1', gateHeadSha: HEAD }, ...over,
  });

  it('a version-1 file with v1 records reads as v2 without throwing; the next write stores v2', async () => {
    fs.writeFileSync(path.join(dir, 'pr-verdicts.json'), JSON.stringify({ version: 1, verdicts: [rec()] }));
    const store = new PrVerdictStore(dir, () => 1_000);
    expect(await store.list('github.com/o/r', 7)).toEqual([{ ...rec(), version: 2 }]);
    await store.record(v2());
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'pr-verdicts.json'), 'utf8')) as { version: number; verdicts: PrVerdictRecord[] };
    expect(saved.version).toBe(2);
    expect(saved.verdicts.map((r) => r.version)).toEqual([2, 2]);
    expect((await store.list('github.com/o/r', 7))[1]).toEqual(v2());
  });

  it('a v1 record handed to record() is stored as v2', async () => {
    const store = new PrVerdictStore(dir, () => 1_000);
    await store.record(rec());
    expect(await store.list('github.com/o/r', 7)).toEqual([{ ...rec(), version: 2 }]);
  });

  it('shape: a bot principal needs no pane; a v2 record needs a pane or a bot; v1 stays strict', () => {
    expect(isPrVerdictRecord(v2())).toBe(true);
    expect(isPrVerdictRecord(v2({ evidence: undefined }))).toBe(true);
    expect(isPrVerdictRecord(v2({ principal: { workspaceId: 'ws-v', ptyId: 'pty-v', agent: 'claude' } }))).toBe(true);
    expect(isPrVerdictRecord(v2({ principal: { workspaceId: 'ws-v', agent: 'claude' } }))).toBe(false);
    expect(isPrVerdictRecord(v2({ principal: { workspaceId: 'ws-v', botId: '', agent: 'claude' } }))).toBe(false);
    expect(isPrVerdictRecord(v2({ evidence: { taskId: 'task-1', gateHeadSha: 'not-a-sha' } }))).toBe(false);
    expect(isPrVerdictRecord(v2({ evidence: { taskId: '', gateHeadSha: HEAD } }))).toBe(false);
    expect(isPrVerdictRecord(rec({ principal: { workspaceId: 'ws-v', agent: 'claude' } }))).toBe(false);
    expect(isPrVerdictRecord(rec({ evidence: { taskId: 'task-1', gateHeadSha: HEAD } }))).toBe(false);
    expect(isPrVerdictRecord({ ...rec(), version: 3 })).toBe(false);
  });
});
