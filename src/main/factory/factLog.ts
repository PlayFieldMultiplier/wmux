// ─── Fact log — the factory's durable, deduplicated event record ───────────
//
// `<wmuxDir>/factory/facts.jsonl`: one Fact (shared/facts.ts) per line, in
// seq order. Rotated past FACT_LIMITS.ROTATE_BYTES to `facts.<n>.jsonl`
// (higher n = newer); a rotated file older than FACT_RETAIN_DAYS is deleted,
// and on start expired lines are compacted out of the live file.
// `fact-cursors.json` keeps the last seq and the dedupe index so both survive
// a lost or quarantined log; the index is also rebuilt from the log on start,
// so a crash between an append and the cursor write loses nothing.
//
// Guarantees:
//   - `append` is synchronous: the line is written before the fact is
//     returned, and subscribers see facts exactly once, in seq order (a
//     subscriber that appends is queued behind the delivery under way).
//   - seq is strictly increasing across restarts, rotation and quarantine.
//   - A draft whose dedupe key cannot be built, whose payload is too large,
//     or whose key was already written inside the retain window is refused
//     (null) and nothing is written.
//   - A fact is acknowledged only once its whole line is written; a failed
//     or short write is rolled back and refused (`write_failed`), and while
//     the file cannot be opened every append is refused (retried every few
//     seconds) — the log never acknowledges a fact it did not persist.
//   - A corrupt line is skipped and counted, never fatal. A live file that
//     cannot be read is quarantined (`factory/corrupted/`) and the log starts
//     fresh, its seq skipping QUARANTINE_SEQ_GAP past the last checkpoint so
//     no seq a reader may hold from the quarantined file is reused.
//   - Reads serve the newest FACT_MEMORY_MAX retained facts (memory); older
//     retained facts stay on disk for evidence but a cursor before them
//     resumes at the oldest fact in memory.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { quarantineFileSync } from '../../daemon/util/atomicWrite/quarantine';
import { redactStoredSecretsDeep } from './secretRedaction';
import {
  FACT_LIMITS,
  FACT_RETAIN_DAYS,
  factDedupeKey,
  isFactKind,
  type Fact,
  type FactDraft,
  type FactFilter,
} from '../../shared/facts';

export const FACTS_FILENAME = 'facts.jsonl';
export const FACT_CURSORS_FILENAME = 'fact-cursors.json';
/** Rotated files kept at most (oldest deleted first), whatever their age. */
export const FACT_MAX_ROTATED_FILES = 8;
/** Facts held in memory for reads; older retained facts stay on disk only. */
export const FACT_MEMORY_MAX = 50_000;
const CURSOR_FLUSH_MS = 1_000;
const REOPEN_RETRY_MS = 5_000;
/** How far seq skips ahead after a quarantine: more than the facts that can
 *  be appended between two cursor checkpoints. */
export const QUARANTINE_SEQ_GAP = 10_000;
const DAY_MS = 24 * 3600_000;
const ROTATED_RE = /^facts\.(\d+)\.jsonl$/;

export interface FactLogApi {
  /** null = deduped or refused (nothing written). */
  append(draft: FactDraft): Fact | null;
  subscribe(fn: (f: Fact) => void): () => void;
  /** Facts after `cursor` (null = from the oldest retained fact) that match
   *  `filter`, at most `limit` (≤ FACT_LIMITS.POLL_PAGE). The returned cursor
   *  is passed back to continue; it moves past facts the filter skipped. */
  readSince(cursor: string | null, filter?: FactFilter, limit?: number): { facts: Fact[]; cursor: string | null };
}

export type FactAppendResult =
  | { ok: true; fact: Fact }
  | { ok: false; code: 'invalid' | 'too_large' | 'duplicate' | 'write_failed' | 'stopped' };

export interface FactLogStats {
  corruptLines: number;
  deduped: number;
  refused: number;
  writeErrors: number;
  /** Where an unreadable live file was moved on start, if it was. */
  quarantinedTo: string | null;
  /** False when the log runs in memory only (the file could not be opened). */
  durable: boolean;
}

export interface FactLog extends FactLogApi {
  start(): void;
  dispose(): void;
  appendResult(draft: FactDraft): FactAppendResult;
  /** Facts with seq > afterSeq that pass `match`, oldest first. `lastSeq` is
   *  the highest seq examined (the next afterSeq). */
  readWhere(afterSeq: number, match: (f: Fact) => boolean, limit: number): { facts: Fact[]; lastSeq: number };
  latestSeq(): number;
  stats(): FactLogStats;
}

export interface FactLogOptions {
  now?: () => number;
  rotateBytes?: number;
  retainMs?: number;
  log?: (line: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isStoredFact(v: unknown): v is Fact {
  return isRecord(v)
    && typeof v.id === 'string'
    && typeof v.seq === 'number' && Number.isSafeInteger(v.seq) && v.seq > 0
    && isFactKind(v.kind)
    && typeof v.at === 'number' && Number.isFinite(v.at)
    && typeof v.dedupeKey === 'string' && v.dedupeKey.length > 0
    && isRecord(v.payload);
}

/** Time-ordered unique id (ms time in base36 + random), sortable by time. */
function factId(at: number): string {
  return `f-${Math.max(0, Math.floor(at)).toString(36).padStart(9, '0')}-${crypto.randomBytes(6).toString('hex')}`;
}

/** The FactFilter predicate. `authorTrusted` passes only facts whose source
 *  stamped `payload.authorTrusted === true`; the log knows no trust list. */
export function factMatchesFilter(f: Fact, filter: FactFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.repoKey !== undefined && f.repoKey !== filter.repoKey) return false;
  if (filter.botIdNot !== undefined && f.ref?.botId === filter.botIdNot) return false;
  if (filter.authorTrusted === true && f.payload.authorTrusted !== true) return false;
  if (filter.labelsAny && filter.labelsAny.length > 0) {
    const labels = new Set<string>();
    if (typeof f.ref?.label === 'string') labels.add(f.ref.label);
    if (Array.isArray(f.payload.labels)) for (const l of f.payload.labels) if (typeof l === 'string') labels.add(l);
    if (!filter.labelsAny.some((l) => labels.has(l))) return false;
  }
  return true;
}

interface CursorFile { version: 1; seq: number; dedupe: Record<string, number> }

function isCursorFile(v: unknown): v is CursorFile {
  return isRecord(v) && v.version === 1 && typeof v.seq === 'number' && Number.isSafeInteger(v.seq) && v.seq >= 0
    && isRecord(v.dedupe) && Object.values(v.dedupe).every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function createFactLog(dir: string, opts: FactLogOptions = {}): FactLog {
  const now = opts.now ?? Date.now;
  const rotateBytes = opts.rotateBytes ?? FACT_LIMITS.ROTATE_BYTES;
  const retainMs = opts.retainMs ?? FACT_RETAIN_DAYS * DAY_MS;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const file = path.join(dir, FACTS_FILENAME);
  const cursorFile = path.join(dir, FACT_CURSORS_FILENAME);

  let facts: Fact[] = [];
  const dedupe = new Map<string, number>();
  let seq = 0;
  let fd: number | null = null;
  let size = 0;
  let lastOpenAttempt = 0;
  let started = false;
  let stopped = false;
  let cursorTimer: NodeJS.Timeout | null = null;
  const subscribers = new Set<(f: Fact) => void>();
  const deliveries: Fact[] = [];
  let delivering = false;
  const stats: FactLogStats = { corruptLines: 0, deduped: 0, refused: 0, writeErrors: 0, quarantinedTo: null, durable: false };

  const cutoff = (): number => now() - retainMs;

  function rotatedFiles(): { n: number; full: string }[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => ({ m: ROTATED_RE.exec(name), name }))
      .filter((x): x is { m: RegExpExecArray; name: string } => x.m !== null)
      .map(({ m, name }) => ({ n: Number(m[1]), full: path.join(dir, name) }))
      .sort((a, b) => a.n - b.n);
  }

  /** Delete rotated files past the retain window or beyond the count cap. */
  function sweepRotated(): void {
    const files = rotatedFiles();
    const limit = cutoff();
    files.forEach((f, i) => {
      let expired = files.length - i > FACT_MAX_ROTATED_FILES;
      if (!expired) {
        try {
          expired = fs.statSync(f.full).mtimeMs < limit;
        } catch {
          return;
        }
      }
      if (expired) {
        try {
          fs.unlinkSync(f.full);
        } catch (err) {
          log(`[facts] could not delete ${path.basename(f.full)}: ${String(err)}`);
        }
      }
    });
  }

  function pruneMemory(): void {
    const limit = cutoff();
    let drop = 0;
    while (drop < facts.length && (facts[drop].at < limit || facts.length - drop > FACT_MEMORY_MAX)) drop++;
    if (drop > 0) facts = facts.slice(drop);
    for (const [key, at] of dedupe) if (at < limit) dedupe.delete(key);
  }

  /** Parse one file's lines. `expired` counts valid facts past the window. */
  function parseLines(text: string): { valid: Fact[]; expired: number; corrupt: number; maxSeq: number } {
    const limit = cutoff();
    const valid: Fact[] = [];
    let expired = 0;
    let corrupt = 0;
    let maxSeq = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corrupt++;
        continue;
      }
      if (!isStoredFact(parsed)) {
        corrupt++;
        continue;
      }
      // Expired lines still count for seq: a seq once written is never reused.
      maxSeq = Math.max(maxSeq, parsed.seq);
      if (parsed.at < limit) expired++;
      else valid.push(parsed);
    }
    return { valid, expired, corrupt, maxSeq };
  }

  function admit(f: Fact): void {
    if (f.seq <= seq) return; // a line out of order is not replayed twice
    facts.push(f);
    seq = f.seq;
    const prev = dedupe.get(f.dedupeKey);
    if (prev === undefined || prev < f.at) dedupe.set(f.dedupeKey, f.at);
  }

  function loadCursorFile(): void {
    let saved: CursorFile | null = null;
    try {
      saved = atomicReadJSONSync<CursorFile>(cursorFile, { validate: isCursorFile });
    } catch {
      saved = null;
    }
    if (!saved) return;
    seq = Math.max(seq, saved.seq);
    const limit = cutoff();
    for (const [key, at] of Object.entries(saved.dedupe)) {
      if (at >= limit && (dedupe.get(key) ?? -Infinity) < at) dedupe.set(key, at);
    }
  }

  function writeCursorFile(): void {
    if (cursorTimer) {
      clearTimeout(cursorTimer);
      cursorTimer = null;
    }
    try {
      atomicWriteJSONSync(cursorFile, { version: 1, seq, dedupe: Object.fromEntries(dedupe) } satisfies CursorFile);
    } catch (err) {
      log(`[facts] cursor write failed: ${String(err)}`);
    }
  }

  function scheduleCursorWrite(): void {
    if (cursorTimer || stopped) return;
    cursorTimer = setTimeout(writeCursorFile, CURSOR_FLUSH_MS);
    cursorTimer.unref?.();
  }

  function openForAppend(): void {
    lastOpenAttempt = now();
    try {
      fd = fs.openSync(file, 'a');
      size = fs.fstatSync(fd).size;
      if (size > 0) {
        // A torn last line (crash mid-write) must not swallow the next one.
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(file, 'r');
        try {
          fs.readSync(rfd, last, 0, 1, size - 1);
        } finally {
          fs.closeSync(rfd);
        }
        if (last[0] !== 0x0a) size += fs.writeSync(fd, '\n');
      }
      stats.durable = true;
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
      }
      fd = null;
      stats.durable = false;
      log(`[facts] ${FACTS_FILENAME} cannot be opened; appends are refused until it can: ${String(err)}`);
    }
  }

  function rotate(): void {
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch { /* best-effort */ }
    fd = null;
    const next = (rotatedFiles().at(-1)?.n ?? 0) + 1;
    try {
      fs.renameSync(file, path.join(dir, `facts.${next}.jsonl`));
    } catch (err) {
      log(`[facts] rotation failed: ${String(err)}`);
    }
    // Checkpoint before the sweep may delete a file holding live dedupe keys.
    writeCursorFile();
    sweepRotated();
    openForAppend();
  }

  function deliver(f: Fact): void {
    deliveries.push(f);
    if (delivering) return;
    delivering = true;
    try {
      while (deliveries.length > 0) {
        const next = deliveries.shift() as Fact;
        for (const fn of [...subscribers]) {
          try {
            fn(next);
          } catch (err) {
            log(`[facts] subscriber threw: ${String(err)}`);
          }
        }
      }
    } finally {
      delivering = false;
    }
  }

  /** Write one whole line; on a failed or short write, cut the file back to
   *  where it was so no partial line stays behind. */
  function writeLine(handle: number, line: string): boolean {
    const buf = Buffer.from(line, 'utf8');
    const before = size;
    let off = 0;
    try {
      while (off < buf.length) {
        const n = fs.writeSync(handle, buf, off, buf.length - off);
        if (n <= 0) throw new Error('short write');
        off += n;
      }
      size += buf.length;
      return true;
    } catch (err) {
      log(`[facts] append failed: ${String(err)}`);
      try {
        fs.ftruncateSync(handle, before);
      } catch { /* the torn line is skipped and counted on the next start */ }
      return false;
    }
  }

  function appendResult(raw: FactDraft): FactAppendResult {
    if (stopped || !started) return { ok: false, code: 'stopped' };
    // A stored bot secret never lands in the log, in any field or in the
    // dedupe key derived from them (secretRedaction.ts).
    const draft = redactStoredSecretsDeep(raw);
    if (!isRecord(draft) || !isFactKind(draft.kind) || typeof draft.at !== 'number' || !Number.isFinite(draft.at)
      || !isRecord(draft.payload)
      || (draft.workspaceId !== undefined && typeof draft.workspaceId !== 'string')
      || (draft.repoKey !== undefined && typeof draft.repoKey !== 'string')
      || (draft.ref !== undefined && !isRecord(draft.ref))) {
      stats.refused++;
      return { ok: false, code: 'invalid' };
    }
    const dedupeKey = factDedupeKey(draft);
    if (!dedupeKey) {
      stats.refused++;
      return { ok: false, code: 'invalid' };
    }
    if (Buffer.byteLength(JSON.stringify(draft.payload), 'utf8') > FACT_LIMITS.PAYLOAD_MAX_BYTES) {
      stats.refused++;
      return { ok: false, code: 'too_large' };
    }
    const seen = dedupe.get(dedupeKey);
    if (seen !== undefined && seen >= cutoff()) {
      stats.deduped++;
      return { ok: false, code: 'duplicate' };
    }
    const fact: Fact = {
      id: factId(draft.at),
      seq: seq + 1,
      kind: draft.kind,
      at: draft.at,
      dedupeKey,
      ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
      ...(draft.repoKey ? { repoKey: draft.repoKey } : {}),
      ...(draft.ref ? { ref: draft.ref } : {}),
      ...(draft.actor ? { actor: draft.actor } : {}),
      payload: draft.payload,
    };
    if (fd === null && now() - lastOpenAttempt >= REOPEN_RETRY_MS) openForAppend();
    if (fd === null || !writeLine(fd, `${JSON.stringify(fact)}\n`)) {
      stats.writeErrors++;
      return { ok: false, code: 'write_failed' };
    }
    seq = fact.seq;
    facts.push(fact);
    dedupe.set(dedupeKey, fact.at);
    if (facts.length > FACT_MEMORY_MAX || facts[0].at < cutoff()) pruneMemory();
    if (size > rotateBytes) rotate();
    scheduleCursorWrite();
    deliver(fact);
    return { ok: true, fact };
  }

  function readWhere(afterSeq: number, match: (f: Fact) => boolean, limit: number): { facts: Fact[]; lastSeq: number } {
    // A cursor ahead of the log means the log was reset under the reader.
    const from = afterSeq > seq ? 0 : afterSeq;
    let lo = 0;
    let hi = facts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (facts[mid].seq <= from) lo = mid + 1;
      else hi = mid;
    }
    const out: Fact[] = [];
    const limitAt = cutoff();
    let lastSeq = from;
    for (let i = lo; i < facts.length && out.length < limit; i++) {
      lastSeq = facts[i].seq;
      if (facts[i].at >= limitAt && match(facts[i])) out.push(facts[i]);
    }
    return { facts: out, lastSeq };
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        log(`[facts] cannot create ${dir}: ${String(err)}`);
      }
      sweepRotated();
      for (const r of rotatedFiles()) {
        try {
          const parsed = parseLines(fs.readFileSync(r.full, 'utf8'));
          stats.corruptLines += parsed.corrupt;
          for (const f of parsed.valid) admit(f);
          seq = Math.max(seq, parsed.maxSeq);
        } catch (err) {
          log(`[facts] skipped unreadable ${path.basename(r.full)}: ${String(err)}`);
        }
      }
      let text: string | null = null;
      let quarantined = false;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          quarantined = true;
          const moved = quarantineFileSync(file, `unreadable: ${String(err)}`);
          stats.quarantinedTo = moved?.quarantined_to ?? null;
          log(`[facts] ${FACTS_FILENAME} unreadable; starting fresh${moved ? ` (moved to ${moved.quarantined_to})` : ''}`);
        }
      }
      if (text !== null) {
        const parsed = parseLines(text);
        stats.corruptLines += parsed.corrupt;
        if (parsed.corrupt > 0) log(`[facts] skipped ${parsed.corrupt} corrupt line(s) in ${FACTS_FILENAME}`);
        for (const f of parsed.valid) admit(f);
        seq = Math.max(seq, parsed.maxSeq);
        if (parsed.expired > 0) {
          // Compact: keep only the retained facts (tmp + rename).
          const tmp = `${file}.${process.pid}.tmp`;
          try {
            fs.writeFileSync(tmp, parsed.valid.map((f) => `${JSON.stringify(f)}\n`).join(''));
            fs.renameSync(tmp, file);
          } catch (err) {
            log(`[facts] compaction failed: ${String(err)}`);
            try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
          }
        }
      }
      loadCursorFile();
      if (quarantined) {
        seq += QUARANTINE_SEQ_GAP;
        writeCursorFile();
      }
      pruneMemory();
      openForAppend();
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      subscribers.clear();
      if (started) writeCursorFile();
      if (fd !== null) {
        try {
          fs.fsyncSync(fd);
        } catch { /* best-effort */ }
        try {
          fs.closeSync(fd);
        } catch { /* best-effort */ }
        fd = null;
      }
    },
    appendResult,
    append(draft) {
      const r = appendResult(draft);
      return r.ok ? r.fact : null;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    readSince(cursor, filter, limit) {
      const after = cursor !== null && /^\d{1,15}$/.test(cursor) ? Number(cursor) : 0;
      const page = Math.min(FACT_LIMITS.POLL_PAGE, Math.max(1, Math.floor(limit ?? FACT_LIMITS.POLL_PAGE)));
      const r = readWhere(after, (f) => factMatchesFilter(f, filter), page);
      return { facts: r.facts, cursor: r.lastSeq > 0 ? String(r.lastSeq) : cursor };
    },
    readWhere,
    latestSeq: () => seq,
    stats: () => ({ ...stats }),
  };
}

let current: FactLogApi | null = null;

/** The running app's fact log (set by the fact module's start), or null. */
export function getFactLog(): FactLogApi | null {
  return current;
}

export function setFactLog(next: FactLogApi | null): void {
  current = next;
}
