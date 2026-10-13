// The fact log on a real tmp dir: dedupe across restart, seq order, retention
// and rotation, corrupt lines, an unreadable file, subscribe/unsubscribe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FACTS_FILENAME,
  FACT_CURSORS_FILENAME,
  QUARANTINE_SEQ_GAP,
  createFactLog,
  factMatchesFilter,
  type FactLog,
} from '../factLog';
import { FACT_LIMITS, type Fact, type FactDraft } from '../../../shared/facts';

const DAY = 24 * 3600_000;
const NOW = 100 * DAY;

const taskDone = (taskId: string, over: Partial<FactDraft> = {}): FactDraft => ({
  kind: 'task.done', at: NOW, workspaceId: 'ws-1', ref: { taskId }, payload: {}, ...over,
});

let dir: string;
const open: FactLog[] = [];
function make(opts: Parameters<typeof createFactLog>[1] = {}): FactLog {
  const log = createFactLog(dir, { now: () => NOW, log: () => undefined, ...opts });
  log.start();
  open.push(log);
  return log;
}
const lines = (name = FACTS_FILENAME): string[] =>
  fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp1-facts-')); });
afterEach(() => {
  for (const l of open.splice(0)) l.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createFactLog', () => {
  it('appends one line per fact with increasing seq and a dedupe key', () => {
    const log = make();
    const a = log.append(taskDone('t1'));
    const b = log.append(taskDone('t2'));
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
    expect(a?.dedupeKey).toBe('task.done:t1');
    expect(lines().map((l) => (JSON.parse(l) as Fact).seq)).toEqual([1, 2]);
  });

  it('drops a repeat dedupe key, also after a restart', () => {
    const log = make();
    expect(log.append(taskDone('t1'))).not.toBeNull();
    expect(log.appendResult(taskDone('t1'))).toEqual({ ok: false, code: 'duplicate' });
    log.dispose();
    const again = make();
    expect(again.appendResult(taskDone('t1'))).toEqual({ ok: false, code: 'duplicate' });
    expect(again.append(taskDone('t2'))?.seq).toBe(2);
  });

  it('a reader resumes from its cursor after a crash (no dispose, no checkpoint)', () => {
    const log = make();
    for (const id of ['t1', 't2', 't3']) log.append(taskDone(id));
    // No dispose: the cursor file was never written.
    expect(fs.existsSync(path.join(dir, FACT_CURSORS_FILENAME))).toBe(false);
    const again = make();
    const r = again.readSince('1');
    expect(r.facts.map((f) => f.ref?.taskId)).toEqual(['t2', 't3']);
    expect(r.cursor).toBe('3');
    expect(again.append(taskDone('t4'))?.seq).toBe(4);
    expect(again.readSince(r.cursor).facts.map((f) => f.seq)).toEqual([4]);
  });

  it('keeps dedupe and seq through the cursor file when the log itself is gone', () => {
    const log = make();
    log.append(taskDone('t1'));
    log.append(taskDone('t2'));
    log.dispose();
    fs.unlinkSync(path.join(dir, FACTS_FILENAME));
    const again = make();
    expect(again.appendResult(taskDone('t1')).ok).toBe(false);
    expect(again.append(taskDone('t3'))?.seq).toBe(3);
  });

  it('refuses a draft whose key cannot be built, or whose payload is too large', () => {
    const log = make();
    expect(log.appendResult({ kind: 'task.done', at: NOW, payload: {} })).toEqual({ ok: false, code: 'invalid' });
    expect(log.appendResult({ kind: 'nope' as never, at: NOW, payload: {} })).toEqual({ ok: false, code: 'invalid' });
    expect(log.appendResult(taskDone('t1', { payload: { x: 'y'.repeat(FACT_LIMITS.PAYLOAD_MAX_BYTES) } })))
      .toEqual({ ok: false, code: 'too_large' });
    expect(log.stats().refused).toBe(3);
    expect(fs.readFileSync(path.join(dir, FACTS_FILENAME), 'utf8')).toBe('');
  });

  it('refuses appends before start and after dispose', () => {
    const log = createFactLog(dir, { now: () => NOW, log: () => undefined });
    expect(log.appendResult(taskDone('t1'))).toEqual({ ok: false, code: 'stopped' });
    log.start();
    log.dispose();
    expect(log.append(taskDone('t1'))).toBeNull();
  });

  it('readSince pages in seq order and returns a cursor that continues', () => {
    const log = make();
    for (let i = 1; i <= 5; i++) log.append(taskDone(`t${i}`));
    const first = log.readSince(null, undefined, 2);
    expect(first.facts.map((f) => f.seq)).toEqual([1, 2]);
    expect(first.cursor).toBe('2');
    const rest = log.readSince(first.cursor, undefined, 10);
    expect(rest.facts.map((f) => f.seq)).toEqual([3, 4, 5]);
    expect(log.readSince(rest.cursor).facts).toEqual([]);
    expect(log.readSince(rest.cursor).cursor).toBe('5');
  });

  it('readSince moves the cursor past facts the filter skipped', () => {
    const log = make();
    log.append(taskDone('t1', { repoKey: 'h/o/a' }));
    log.append(taskDone('t2', { repoKey: 'h/o/b' }));
    const r = log.readSince(null, { repoKey: 'h/o/a' });
    expect(r.facts.map((f) => f.ref?.taskId)).toEqual(['t1']);
    expect(r.cursor).toBe('2');
  });

  it('a cursor ahead of the log (reset) reads from the start', () => {
    const log = make();
    log.append(taskDone('t1'));
    expect(log.readSince('999').facts.map((f) => f.seq)).toEqual([1]);
  });

  it('skips and counts corrupt lines (torn tail included) and keeps appending cleanly', () => {
    const good = { id: 'f-1', seq: 1, kind: 'task.done', at: NOW, dedupeKey: 'task.done:t1', workspaceId: 'ws-1', ref: { taskId: 't1' }, payload: {} };
    fs.writeFileSync(path.join(dir, FACTS_FILENAME), `${JSON.stringify(good)}\nnot json\n{"seq":2}\n{"id":"f-tor`);
    const log = make();
    expect(log.stats().corruptLines).toBe(3);
    expect(log.readSince(null).facts.map((f) => f.seq)).toEqual([1]);
    expect(log.append(taskDone('t2'))?.seq).toBe(2);
    const last = JSON.parse(lines().at(-1) as string) as Fact;
    expect(last.ref?.taskId).toBe('t2');
  });

  it('quarantines an unreadable live file and starts fresh', () => {
    fs.mkdirSync(path.join(dir, FACTS_FILENAME)); // a directory: unreadable as a file
    const log = make();
    expect(log.stats().quarantinedTo).toMatch(/corrupted/);
    expect(log.stats().durable).toBe(true);
    expect(log.append(taskDone('t1'))?.seq).toBe(QUARANTINE_SEQ_GAP + 1);
    expect(lines()).toHaveLength(1);
  });

  it('refuses appends it cannot persist while the file cannot be opened', () => {
    const log = createFactLog(path.join(dir, 'missing', '\0bad'), { now: () => NOW, log: () => undefined });
    log.start();
    open.push(log);
    const seen: Fact[] = [];
    log.subscribe((f) => seen.push(f));
    expect(log.stats().durable).toBe(false);
    expect(log.appendResult(taskDone('t1'))).toEqual({ ok: false, code: 'write_failed' });
    expect(log.stats().writeErrors).toBe(1);
    expect(seen).toEqual([]);
    expect(log.readSince(null).facts).toEqual([]);
  });

  it('rolls back a failed partial write and acknowledges nothing; the key stays free', () => {
    const log = make();
    log.append(taskDone('t1'));
    const real = fsModule.writeSync;
    const spy = vi.spyOn(fsModule, 'writeSync').mockImplementationOnce(((fd: number, buf: Buffer) => {
      real(fd, buf, 0, 10);
      throw new Error('ENOSPC');
    }) as unknown as typeof fsModule.writeSync);
    try {
      expect(log.appendResult(taskDone('t2'))).toEqual({ ok: false, code: 'write_failed' });
    } finally {
      spy.mockRestore();
    }
    expect(lines().map((l) => (JSON.parse(l) as Fact).seq)).toEqual([1]);
    expect(log.append(taskDone('t2'))?.seq).toBe(2);
    expect(lines().map((l) => (JSON.parse(l) as Fact).ref?.taskId)).toEqual(['t1', 't2']);
  });

  it('recovers seq from expired lines too, so a stale checkpoint never reuses one', () => {
    const expired = { id: 'f-7', seq: 7, kind: 'task.done', at: NOW - 40 * DAY, dedupeKey: 'task.done:x', ref: { taskId: 'x' }, payload: {} };
    fs.writeFileSync(path.join(dir, FACTS_FILENAME), `${JSON.stringify(expired)}\n`);
    fs.writeFileSync(path.join(dir, FACT_CURSORS_FILENAME), JSON.stringify({ version: 1, seq: 6, dedupe: {} }));
    expect(make().append(taskDone('t1'))?.seq).toBe(8);
  });

  it('skips seq ahead past the checkpoint after a quarantine', () => {
    fs.writeFileSync(path.join(dir, FACT_CURSORS_FILENAME), JSON.stringify({ version: 1, seq: 3, dedupe: {} }));
    fs.mkdirSync(path.join(dir, FACTS_FILENAME));
    expect(make().append(taskDone('t1'))?.seq).toBe(3 + QUARANTINE_SEQ_GAP + 1);
  });

  it('stops serving facts once they pass retention, without a restart', () => {
    let now = NOW;
    const log = make({ now: () => now });
    log.append(taskDone('t1'));
    expect(log.readSince(null).facts).toHaveLength(1);
    now = NOW + 31 * DAY;
    expect(log.readSince(null).facts).toEqual([]);
    expect(log.append(taskDone('t1', { at: now }))?.seq).toBe(2);
    expect(log.readSince(null).facts.map((f) => f.seq)).toEqual([2]);
  });

  it('compacts expired lines out of the live file on start; their keys may repeat', () => {
    let now = NOW;
    const log = make({ now: () => now });
    log.append(taskDone('old', { at: NOW }));
    log.dispose();
    now = NOW + 31 * DAY;
    const later = make({ now: () => now });
    expect(later.readSince(null).facts).toEqual([]);
    expect(lines()).toEqual([]);
    expect(later.append(taskDone('old', { at: now }))?.seq).toBe(2);
  });

  it('rotates past the size limit and deletes rotated files past retention', () => {
    let now = NOW;
    const log = make({ rotateBytes: 300, now: () => now });
    for (let i = 0; i < 6; i++) log.append(taskDone(`t${i}`, { payload: { pad: 'x'.repeat(100) } }));
    const rotated = fs.readdirSync(dir).filter((n) => /^facts\.\d+\.jsonl$/.test(n));
    expect(rotated.length).toBeGreaterThan(0);
    // Rotation checkpoints the cursor file before any sweep.
    expect(JSON.parse(fs.readFileSync(path.join(dir, FACT_CURSORS_FILENAME), 'utf8')).seq).toBeGreaterThan(0);
    log.dispose();
    // A restart replays rotated files too, in order.
    const again = make({ rotateBytes: 300, now: () => now });
    expect(again.readSince(null).facts.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    again.dispose();
    const old = (NOW - 40 * DAY) / 1000;
    for (const n of rotated) fs.utimesSync(path.join(dir, n), old, old);
    now = NOW;
    make({ rotateBytes: 300, now: () => now });
    expect(fs.readdirSync(dir).filter((n) => /^facts\.\d+\.jsonl$/.test(n))).toEqual([]);
  });

  it('subscribers see each fact once, in seq order, even when a subscriber appends', () => {
    const log = make();
    const seen: number[] = [];
    const off = log.subscribe((f) => {
      seen.push(f.seq);
      if (f.ref?.taskId === 't1') log.append(taskDone('t2'));
    });
    const other: number[] = [];
    log.subscribe((f) => other.push(f.seq));
    log.append(taskDone('t1'));
    expect(seen).toEqual([1, 2]);
    expect(other).toEqual([1, 2]);
    off();
    log.append(taskDone('t3'));
    expect(seen).toEqual([1, 2]);
    expect(other).toEqual([1, 2, 3]);
  });

  it('a throwing subscriber does not stop the others or the append', () => {
    const log = make();
    const seen: number[] = [];
    log.subscribe(() => { throw new Error('boom'); });
    log.subscribe((f) => seen.push(f.seq));
    expect(log.append(taskDone('t1'))).not.toBeNull();
    expect(seen).toEqual([1]);
  });

  it('flushes the cursor file on dispose', () => {
    vi.useFakeTimers();
    try {
      const log = make();
      log.append(taskDone('t1'));
      log.dispose();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, FACT_CURSORS_FILENAME), 'utf8'));
      expect(saved).toMatchObject({ version: 1, seq: 1, dedupe: { 'task.done:t1': NOW } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('factMatchesFilter', () => {
  const fact = (over: Partial<Fact>): Fact => ({
    id: 'f', seq: 1, kind: 'pr.labelled', at: 0, dedupeKey: 'k', payload: {}, ...over,
  });
  it('matches repoKey, botIdNot, labelsAny and stamped authorTrusted only', () => {
    expect(factMatchesFilter(fact({ repoKey: 'a' }), { repoKey: 'b' })).toBe(false);
    expect(factMatchesFilter(fact({ ref: { botId: 'bot-1' } }), { botIdNot: 'bot-1' })).toBe(false);
    expect(factMatchesFilter(fact({ ref: { label: 'bug' } }), { labelsAny: ['bug'] })).toBe(true);
    expect(factMatchesFilter(fact({ payload: { labels: ['triage'] } }), { labelsAny: ['bug', 'triage'] })).toBe(true);
    expect(factMatchesFilter(fact({}), { labelsAny: ['bug'] })).toBe(false);
    expect(factMatchesFilter(fact({}), { authorTrusted: true })).toBe(false);
    expect(factMatchesFilter(fact({ payload: { authorTrusted: true } }), { authorTrusted: true })).toBe(true);
  });
});
