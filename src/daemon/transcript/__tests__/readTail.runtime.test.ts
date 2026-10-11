// Real-filesystem behaviour of the bounded tail reader: files larger than the
// read cap, truncation mid-write, rotation, and the FIFO refusal that keeps a
// hook-supplied path from blocking the daemon's event loop forever.
//
// Runtime config (`fileParallelism: false`) so tmpdir churn is deterministic.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { TAIL_BYTES, readTranscriptDelta, readTranscriptLineAt, readTranscriptPage } from '../readTail';
import type { ToolResultEvent, TurnEvent } from '../../../shared/transcript/turnEvents';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-readtail-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One synthetic assistant entry, padded so a few thousand of them exceed 2MB. */
function entry(i: number, padBytes = 400): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `synthetic-${String(i).padStart(6, '0')}`,
    timestamp: new Date(Date.UTC(2026, 6, 27, 0, 0, i % 60)).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `line ${i} ${'x'.repeat(padBytes)}` }] },
  });
}

/** One entry whose single line is larger than the read cap. */
function hugeEntry(): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'huge-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(TAIL_BYTES + 5000) }] },
  });
}

/** Is `offset` immediately after a newline (or 0)? The cursor-integrity rule. */
function isBoundary(file: string, offset: number): boolean {
  if (offset === 0) return true;
  const fd = fs.openSync(file, 'r');
  try {
    const probe = Buffer.alloc(1);
    fs.readSync(fd, probe, 0, 1, offset - 1);
    return probe[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function writeEntries(file: string, count: number): void {
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) chunks.push(entry(i));
  fs.writeFileSync(file, chunks.join('\n') + '\n', 'utf8');
}

describe('readTranscriptPage — file far larger than the cap', () => {
  it('reads at most TAIL_BYTES and discards the partial head line', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(2 * 1024 * 1024);

    const page = readTranscriptPage(file)!;
    expect(page.truncatedHead).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.cursor.fileSize).toBe(size);
    expect(page.cursor.tailOffset).toBe(size);
    // The window never exceeds the cap, and the head offset sits inside it.
    expect(size - page.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);
    expect(page.cursor.headOffset).toBeGreaterThan(0);

    // Every event came from a COMPLETE line: the partial head was dropped, so
    // no event is missing its text.
    for (const event of page.events) {
      if (event.kind === 'assistant_text') expect(event.text).toMatch(/^line \d+ x+$/);
    }

    // The head offset is a real line boundary.
    const fd = fs.openSync(file, 'r');
    try {
      const probe = Buffer.alloc(1);
      fs.readSync(fd, probe, 0, 1, page.cursor.headOffset);
      expect(probe.toString('utf8')).toBe('{');
      fs.readSync(fd, probe, 0, 1, page.cursor.headOffset - 1);
      expect(probe.toString('utf8')).toBe('\n');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('pages BACKWARD from a previous headOffset in bounded chunks', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);

    const first = readTranscriptPage(file)!;
    const second = readTranscriptPage(file, { before: first.cursor.headOffset })!;
    expect(second.cursor.tailOffset).toBe(first.cursor.headOffset);
    expect(second.cursor.headOffset).toBeLessThan(first.cursor.headOffset);
    expect(first.cursor.headOffset - second.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);
    expect(second.truncatedHead).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(second.events.length).toBeGreaterThan(0);

    // Walking head-ward terminates at offset 0 with hasMore:false.
    let cursor = second.cursor.headOffset;
    let guard = 0;
    let last = second;
    while (cursor > 0 && guard++ < 200) {
      last = readTranscriptPage(file, { before: cursor })!;
      cursor = last.cursor.headOffset;
    }
    expect(cursor).toBe(0);
    expect(last.hasMore).toBe(false);
    expect(last.truncatedHead).toBe(false);
  });

  it('caps a delta read too, and the next delta picks up the remainder', () => {
    const file = path.join(dir, 'big.jsonl');
    writeEntries(file, 4000);
    const size = fs.statSync(file).size;

    const first = readTranscriptDelta(file, 0)!;
    expect(first.reset).toBe(false);
    expect(first.cursor.tailOffset).toBeLessThan(size);
    expect(first.cursor.tailOffset - first.cursor.headOffset).toBeLessThanOrEqual(TAIL_BYTES);

    let offset = first.cursor.tailOffset;
    let guard = 0;
    while (offset < size && guard++ < 200) {
      const next = readTranscriptDelta(file, offset)!;
      expect(next.reset).toBe(false);
      expect(next.cursor.tailOffset).toBeGreaterThan(offset);
      offset = next.cursor.tailOffset;
    }
    expect(offset).toBe(size);
  });

  it('reads a COMPLETE entry larger than the cap whole, landing on a boundary', () => {
    const file = path.join(dir, 'huge-line.jsonl');
    fs.writeFileSync(file, hugeEntry() + '\n' + entry(1) + '\n', 'utf8');

    const first = readTranscriptDelta(file, 0)!;
    // D1(a) — the record is read whole and parsed like any other line, so the
    // conversation has neither a silent hole nor a "skipped" placeholder.
    expect(first.stalled).toBeUndefined();
    expect(first.events.map((e) => [e.id, e.kind])).toEqual([['huge-1', 'assistant_text']]);
    // D1(b) — and the cursor lands on a real line boundary, so the consumer's
    // boundary check does not fail and reset the view on every later read.
    expect(isBoundary(file, first.cursor.tailOffset)).toBe(true);

    let offset = first.cursor.tailOffset;
    let guard = 0;
    const size = fs.statSync(file).size;
    while (offset < size && guard++ < 20) {
      const next = readTranscriptDelta(file, offset)!;
      expect(next.cursor.tailOffset).toBeGreaterThan(offset);
      offset = next.cursor.tailOffset;
    }
    expect(offset).toBe(size);
  });

  it('STALLS instead of advancing while an oversized entry is unterminated', () => {
    const file = path.join(dir, 'partial-huge.jsonl');
    // No trailing newline: the writer is still mid-entry.
    fs.writeFileSync(file, hugeEntry(), 'utf8');

    const stalled = readTranscriptDelta(file, 0)!;
    expect(stalled.stalled).toBe(true);
    expect(stalled.events).toEqual([]);
    // The cursor did NOT move into the middle of the record — that is what used
    // to make every subsequent read fail its boundary check and reset the rows.
    expect(stalled.cursor.tailOffset).toBe(0);

    // Once the newline lands, the same read makes progress.
    fs.appendFileSync(file, '\n' + entry(1) + '\n', 'utf8');
    const after = readTranscriptDelta(file, 0)!;
    expect(after.stalled).toBeUndefined();
    expect(after.cursor.tailOffset).toBeGreaterThan(0);
    expect(isBoundary(file, after.cursor.tailOffset)).toBe(true);
  });

  it('keeps headOffset strictly decreasing when the record before it is oversized', () => {
    const file = path.join(dir, 'huge-then-small.jsonl');
    // Small entries, then an oversized one, then more small ones: paging
    // backward has to cross the oversized record without stalling on it.
    const head = [entry(0), entry(1)].join('\n');
    fs.writeFileSync(file, `${head}\n${hugeEntry()}\n${entry(2)}\n${entry(3)}\n`, 'utf8');

    let cursor = readTranscriptPage(file)!.cursor.headOffset;
    let guard = 0;
    const seen = new Set<number>([cursor]);
    while (cursor > 0 && guard++ < 400) {
      const page = readTranscriptPage(file, { before: cursor })!;
      expect(page.cursor.headOffset).toBeLessThan(cursor);
      cursor = page.cursor.headOffset;
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
    // D1(c) — "Load earlier" reaches the head of the file instead of returning
    // the same empty page forever.
    expect(cursor).toBe(0);
  });

  it('keeps byte offsets exact across multibyte and invalid UTF-8', () => {
    const file = path.join(dir, 'utf8.jsonl');
    // Multibyte prose plus a raw invalid byte in a line the parser will reject.
    // Both used to decode to U+FFFD and skew every offset that followed.
    const multibyte = JSON.stringify({
      type: 'assistant',
      uuid: 'mb-1',
      message: { role: 'assistant', content: [{ type: 'text', text: '한글 프롬프트 🇰🇷 émoji' }] },
    });
    const parts = [
      Buffer.from(multibyte + '\n', 'utf8'),
      Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]), // {"<bad>"} + \n
      Buffer.from(entry(9) + '\n', 'utf8'),
    ];
    fs.writeFileSync(file, Buffer.concat(parts));
    const size = fs.statSync(file).size;

    const delta = readTranscriptDelta(file, 0)!;
    // The cursor is a byte offset, so it must land exactly on EOF — a
    // string-length derived offset overshoots or undershoots here.
    expect(delta.cursor.tailOffset).toBe(size);
    // And a code block's srcOffset must point at the line it came from.
    const withCode = JSON.stringify({
      type: 'assistant',
      uuid: 'mb-2',
      message: { role: 'assistant', content: [{ type: 'text', text: '설명\n```ts\nconst a = 1;\n```' }] },
    });
    fs.appendFileSync(file, withCode + '\n', 'utf8');
    const next = readTranscriptDelta(file, size)!;
    const codeEvent = next.events.find((e) => e.kind === 'assistant_text' && e.codeBlocks);
    expect(codeEvent).toBeDefined();
    if (codeEvent && codeEvent.kind === 'assistant_text') {
      expect(codeEvent.codeBlocks?.[0].srcOffset).toBe(size);
    }
  });
});

describe('readTranscript* — an image tool result larger than the cap', () => {
  // A screenshot result is one JSONL line holding the image's base64 (twice:
  // in the content block and in `toolUseResult`), routinely past TAIL_BYTES.
  const base64 = 'A'.repeat(3 * 1024 * 1024);
  const toolUse = JSON.stringify({
    type: 'assistant', uuid: 'use-1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'mcp__macos__Snapshot', input: { use_vision: true } }] },
  });
  const image = { type: 'image', source: { type: 'base64', data: base64, media_type: 'image/png' } };
  const toolResult = JSON.stringify({
    type: 'user', uuid: 'result-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: 'Focused app' }, image] }] },
    toolUseResult: { type: 'image', file: { base64, type: 'image/png' } },
  });
  const after = entry(7);
  const write = (file: string) => fs.writeFileSync(file, `${entry(0)}\n${toolUse}\n${toolResult}\n${after}\n`, 'utf8');
  const pairedResult = (events: TurnEvent[]) => events.find((e) => e.kind === 'tool_result') as ToolResultEvent | undefined;

  it('the forward delta yields the tool_result, paired and without the image data', () => {
    const file = path.join(dir, 'image-delta.jsonl');
    write(file);
    const resultAt = Buffer.byteLength(`${entry(0)}\n${toolUse}\n`);
    const delta = readTranscriptDelta(file, resultAt)!;
    expect(delta.stalled).toBeUndefined();
    expect(delta.events).toHaveLength(1);
    expect(pairedResult(delta.events)).toMatchObject({ kind: 'tool_result', toolUseId: 'toolu_shot', ok: true, output: { inline: 'Focused app\n[image]' } });
    expect(JSON.stringify(delta.events)).not.toContain('AAAAAAAA');
    expect(isBoundary(file, delta.cursor.tailOffset)).toBe(true);
    expect(readTranscriptDelta(file, delta.cursor.tailOffset)!.events.map((e) => e.id)).toEqual(['synthetic-000007']);
  });

  it('a snapshot whose window starts inside it still returns it, with the head on its start', () => {
    const file = path.join(dir, 'image-page.jsonl');
    write(file);
    const page = readTranscriptPage(file)!;
    expect(page.events.map((e) => e.kind)).toEqual(['tool_result', 'assistant_text']);
    expect(pairedResult(page.events)?.toolUseId).toBe('toolu_shot');
    expect(JSON.stringify(page.events)).not.toContain('AAAAAAAA');
    expect(page.cursor.headOffset).toBe(Buffer.byteLength(`${entry(0)}\n${toolUse}\n`));
    // Paging back from there reaches the tool_use, so the pair is complete.
    const older = readTranscriptPage(file, { before: page.cursor.headOffset })!;
    expect(older.events.filter((e) => e.kind === 'tool_use').map((e) => e.kind === 'tool_use' && e.toolUseId)).toEqual(['toolu_shot']);
    expect(older.cursor.headOffset).toBe(0);
  });

  it('a page ending right after it reads it too, instead of skipping it', () => {
    const file = path.join(dir, 'image-before.jsonl');
    write(file);
    const page = readTranscriptPage(file, { before: Buffer.byteLength(`${entry(0)}\n${toolUse}\n${toolResult}\n`) })!;
    expect(page.events.map((e) => e.kind)).toEqual(['tool_result']);
    expect(page.cursor.headOffset).toBe(Buffer.byteLength(`${entry(0)}\n${toolUse}\n`));
  });

  it('an expand of a body on that line reads the whole line', () => {
    const file = path.join(dir, 'image-line.jsonl');
    write(file);
    const line = readTranscriptLineAt(file, Buffer.byteLength(`${entry(0)}\n${toolUse}\n`));
    expect(line).toBe(toolResult);
  });
});

describe('readTranscriptPage — truncated mid-write', () => {
  it('keeps the last COMPLETE entry and shows no zero-fill artifact', () => {
    const file = path.join(dir, 'partial.jsonl');
    const complete = [entry(1), entry(2)].join('\n') + '\n';
    // A half-written final line: exactly what a reader racing the writer sees.
    fs.writeFileSync(file, complete + '{"type":"assistant","uuid":"synthetic-000003","mess', 'utf8');

    const page = readTranscriptPage(file)!;
    expect(page.events).toHaveLength(2);
    expect(page.cursor.tailOffset).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(page.cursor.tailOffset).toBeLessThan(page.cursor.fileSize);
    const serialized = JSON.stringify(page.events);
    expect(serialized).not.toContain('\u0000');
    expect(serialized).not.toContain('synthetic-000003');
  });

  it('a shrinking file (truncation) makes the next delta a reset', () => {
    const file = path.join(dir, 'shrink.jsonl');
    writeEntries(file, 50);
    const before = readTranscriptDelta(file, 0)!;
    expect(before.reset).toBe(false);

    fs.writeFileSync(file, entry(0) + '\n', 'utf8');
    const after = readTranscriptDelta(file, before.cursor.tailOffset)!;
    expect(after.reset).toBe(true);
    expect(after.events).toHaveLength(1);
    expect(after.cursor.tailOffset).toBe(fs.statSync(file).size);
  });
});

describe('readTranscript* — rotation', () => {
  it('reports reset when the file is replaced by a smaller one', () => {
    const file = path.join(dir, 'rotate.jsonl');
    writeEntries(file, 200);
    const before = readTranscriptDelta(file, 0)!;

    // Atomic replace, the way a rotation or a fresh session arrives.
    const replacement = path.join(dir, 'rotate.next');
    fs.writeFileSync(replacement, entry(999) + '\n', 'utf8');
    fs.renameSync(replacement, file);

    const after = readTranscriptDelta(file, before.cursor.tailOffset)!;
    expect(after.reset).toBe(true);
    expect(after.events).toHaveLength(1);
  });

  it('returns null once the file is deleted', () => {
    const file = path.join(dir, 'gone.jsonl');
    writeEntries(file, 5);
    expect(readTranscriptPage(file)).not.toBeNull();
    fs.rmSync(file);
    expect(readTranscriptPage(file)).toBeNull();
    expect(readTranscriptDelta(file, 0)).toBeNull();
  });
});

describe('readTranscript* — FIFO refusal', () => {
  const isWin32 = process.platform === 'win32';

  it.skipIf(isWin32)('RETURNS on a FIFO instead of blocking on open', () => {
    const fifo = path.join(dir, 'transcript.fifo');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      // No mkfifo on this runner — the lstat guard is covered by the directory
      // case in the unit tests.
      return;
    }
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);

    // The assertion IS that these calls return at all: openSync on a FIFO with
    // no writer blocks forever and there is no timeout that could rescue it.
    const startedAt = Date.now();
    expect(readTranscriptPage(fifo)).toBeNull();
    expect(readTranscriptDelta(fifo, 0)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
