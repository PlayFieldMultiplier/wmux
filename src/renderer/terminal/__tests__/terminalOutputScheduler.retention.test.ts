// Phase 3 (PR-A) — hidden-pane retention policy: hidden bytes are queued but
// never drained (zero renderer parsing), overflow discards + marks dirty, and
// the dirty flag drives the owner's daemon resync. See the module header of
// terminalOutputScheduler.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeTerminalOutput,
  flushTerminalOutput,
  noteTerminalInput,
  discardTerminalOutput,
  getQueuedCharCount,
  isTerminalDirty,
  isTerminalRetained,
  markTerminalDirty,
  markTerminalClean,
  __resetTerminalOutputSchedulerForTests,
  type SchedulableTerminal,
} from '../terminalOutputScheduler';

const MAX_QUEUE_CHARS = 2 * 1024 * 1024; // scheduler cap (kept in sync manually)

function makeTerminal(): SchedulableTerminal & { writes: string[] } {
  const t = {
    writes: [] as string[],
    write(data: string) {
      t.writes.push(data);
    },
  };
  return t;
}

function joined(t: { writes: string[] }): string {
  return t.writes.join('');
}

describe('terminalOutputScheduler — hidden-pane retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it('retained hidden bytes are NEVER drained by timers', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'hidden1', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, 'hidden2', { foreground: false, retainWhenHidden: true });
    vi.advanceTimersByTime(60_000);
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(14);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('a retained backlog does not stall other terminals’ background drain', () => {
    const retained = makeTerminal();
    const normal = makeTerminal();
    writeTerminalOutput(retained, 'held', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(normal, 'flows', { foreground: false });
    vi.runAllTimers();
    expect(joined(normal)).toBe('flows');
    expect(retained.writes).toEqual([]);
  });

  it('a large retained backlog does not promote the drain cadence (no priority leak)', () => {
    const retained = makeTerminal();
    const normal = makeTerminal();
    // Past LARGE_BACKLOG_CHARS (512KB) but under the 2MB cap — retained, so it
    // must neither drain nor drive the priority cadence for others.
    writeTerminalOutput(retained, 'r'.repeat(600 * 1024), { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(normal, 'n', { foreground: false });
    vi.runAllTimers();
    expect(retained.writes).toEqual([]);
    expect(joined(normal)).toBe('n');
  });

  it('flushTerminalOutput (clean reveal) hands over the retained backlog in order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'AA', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, 'BB', { foreground: false, retainWhenHidden: true });
    flushTerminalOutput(t);
    expect(joined(t)).toBe('AABB');
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a foreground write releases the retained backlog ahead of itself (order preserved)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'held', { foreground: false, retainWhenHidden: true });
    // Pane became visible; a keystroke echo arrives before the reveal flush.
    writeTerminalOutput(t, '!', { foreground: true, retainWhenHidden: true });
    vi.runAllTimers();
    expect(joined(t)).toBe('held!');
  });

  it('overflow past the cap discards the backlog and marks the terminal dirty (no parse storm)', () => {
    const t = makeTerminal();
    const half = 'y'.repeat(MAX_QUEUE_CHARS / 2);
    writeTerminalOutput(t, half, { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, half, { foreground: false, retainWhenHidden: true });
    expect(isTerminalDirty(t)).toBe(false);
    writeTerminalOutput(t, 'z', { foreground: false, retainWhenHidden: true }); // crosses cap
    // Unlike the non-retained overflow (flush-to-xterm baseline), retention
    // NEVER hands the flood to the parser — it discards and flags.
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('while dirty, further retained bytes are dropped outright', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    writeTerminalOutput(t, 'lost', { foreground: false, retainWhenHidden: true });
    expect(getQueuedCharCount(t)).toBe(0);
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('markTerminalClean re-arms retention accumulation', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    markTerminalClean(t);
    writeTerminalOutput(t, 'fresh', { foreground: false, retainWhenHidden: true });
    expect(getQueuedCharCount(t)).toBe(5);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('markTerminalDirty discards any queued bytes for the terminal', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'stale-replay', { foreground: false, retainWhenHidden: true });
    markTerminalDirty(t);
    expect(getQueuedCharCount(t)).toBe(0);
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
  });

  it('discardTerminalOutput (teardown) clears the dirty flag too', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    discardTerminalOutput(t);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('isTerminalRetained gates the reveal-backlog-cap: true only for a retained (daemon-backed) queue', () => {
    // A retained hidden write (daemon-backed) → recoverable → safe to cap.
    const daemon = makeTerminal();
    writeTerminalOutput(daemon, 'retained', { foreground: false, retainWhenHidden: true });
    expect(isTerminalRetained(daemon)).toBe(true);

    // A NON-retained background write (possibly a local pane) → the queue is the
    // only copy → must NOT be discarded by the reveal cap.
    const local = makeTerminal();
    writeTerminalOutput(local, 'background', { foreground: false });
    expect(isTerminalRetained(local)).toBe(false);

    // Absent terminal → false.
    const untouched = makeTerminal();
    expect(isTerminalRetained(untouched)).toBe(false);
  });

  it('without retainWhenHidden the hidden path behaves exactly as before (batched drain)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'legacy', { foreground: false });
    vi.runAllTimers();
    expect(joined(t)).toBe('legacy');
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('foreground direct path is unaffected by the retention option (in-window)', () => {
    const t = makeTerminal();
    noteTerminalInput(t); // interactive window → direct path (retention is hidden-only)
    writeTerminalOutput(t, 'echo', { foreground: true, retainWhenHidden: true });
    expect(t.writes).toEqual(['echo']);
  });
});

// A retained pane still answers terminal queries: xterm is its only responder,
// so a chunk that completes a query hands the whole backlog to xterm at once.
describe('terminalOutputScheduler — hidden-pane retention answers queries', () => {
  const DA1 = '\x1b[c';

  /** Fake xterm that "answers" every query it parses, like onData → pty.write. */
  function makeAnsweringTerminal(): SchedulableTerminal & { writes: string[]; answers: number } {
    const t = {
      writes: [] as string[],
      answers: 0,
      write(data: string) {
        t.writes.push(data);
        // Count queries only once they are complete in the parsed stream.
        const parsed = t.writes.join('');
        t.answers = parsed.split(DA1).length - 1;
      },
    };
    return t;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  const hidden = { foreground: false, retainWhenHidden: true } as const;

  it('a query chunk flushes the retained backlog in order, synchronously', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'one ', hidden);
    writeTerminalOutput(t, 'two ', hidden);
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, `probe${DA1}`, hidden);
    expect(joined(t)).toBe(`one two probe${DA1}`);
    expect(t.answers).toBe(1);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a chunk without a query stays retained', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, '\x1b[2 q\x1b[3S\x1b[>5u frame', hidden);
    vi.advanceTimersByTime(60_000);
    expect(t.writes).toEqual([]);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('retention resumes after a query flush', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, DA1, hidden);
    writeTerminalOutput(t, 'later', hidden);
    vi.advanceTimersByTime(60_000);
    expect(joined(t)).toBe(DA1);
    expect(getQueuedCharCount(t)).toBe(5);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('a query split across two chunks flushes once it completes', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'text\x1b[', hidden);
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, 'c', hidden);
    expect(joined(t)).toBe(`text${DA1}`);
    expect(t.answers).toBe(1);
  });

  it('a split query is seen even when a query flush ended mid-sequence', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `${DA1}tail\x1b]11;`, hidden);
    expect(joined(t)).toBe(`${DA1}tail\x1b]11;`);
    writeTerminalOutput(t, '?\x07', hidden);
    expect(joined(t)).toBe(`${DA1}tail\x1b]11;?\x07`);
  });

  it('a query split across a hide (visible start, hidden end) still flushes', () => {
    const t = makeAnsweringTerminal();
    noteTerminalInput(t);
    writeTerminalOutput(t, 'shown\x1b[', { foreground: true, retainWhenHidden: true });
    expect(joined(t)).toBe('shown\x1b[');
    writeTerminalOutput(t, 'c', hidden);
    expect(joined(t)).toBe(`shown${DA1}`);
    expect(t.answers).toBe(1);
  });

  it('a long unfinished payload does not hide a later query', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `\x1b]52;c;${'A'.repeat(10_000)}`, hidden);
    writeTerminalOutput(t, `${'B'.repeat(10_000)}\x07text`, hidden);
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, DA1, hidden);
    expect(t.answers).toBe(1);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a dirty pane drops the query chunk like any other hidden bytes', () => {
    const t = makeAnsweringTerminal();
    markTerminalDirty(t);
    writeTerminalOutput(t, DA1, hidden);
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('a query chunk that overflows the cap marks the pane dirty instead of parsing', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'x'.repeat(MAX_QUEUE_CHARS), hidden);
    writeTerminalOutput(t, DA1, hidden);
    expect(t.writes).toEqual([]);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('showing the pane afterwards does not answer the query a second time', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `boot${DA1}`, hidden);
    writeTerminalOutput(t, 'idle', hidden);
    expect(t.answers).toBe(1);
    // Reveal: the owner flushes the retained remainder, then live output flows.
    flushTerminalOutput(t);
    noteTerminalInput(t);
    writeTerminalOutput(t, 'shown', { foreground: true, retainWhenHidden: true });
    vi.runAllTimers();
    expect(joined(t)).toBe(`boot${DA1}idleshown`);
    expect(t.answers).toBe(1);
  });

  it('logs the query parse at a bounded rate', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const t = makeAnsweringTerminal();
      for (let i = 0; i < 5; i++) writeTerminalOutput(t, DA1, { ...hidden, ptyId: 'daemon-1' });
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('query-parse'));
      expect(lines).toEqual(['[wmux:hidden-retention] query-parse ptyId=daemon-1 chars=3']);
    } finally {
      log.mockRestore();
    }
  });
});
