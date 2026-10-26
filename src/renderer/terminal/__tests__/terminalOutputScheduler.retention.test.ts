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
  noteTerminalDirectWrite,
  promoteTerminalToPriorityDrain,
  __setQueryFlushPosterForTests,
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
// so a chunk that completes a query hands the whole backlog to xterm in the
// next task (one coalesced flush for every query chunk that lands before it).
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
        t.answers = t.writes.join('').split(DA1).length - 1;
      },
    };
    return t;
  }

  /** Run the next posted flush task (routed through fake timers below). */
  const settle = () => vi.advanceTimersByTime(1);

  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
    __setQueryFlushPosterForTests((run) => { setTimeout(run, 0); });
  });

  afterEach(() => {
    __setQueryFlushPosterForTests(null);
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  const hidden = { foreground: false, retainWhenHidden: true } as const;

  it('a query chunk flushes the retained backlog in order, in the next task', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'one ', hidden);
    writeTerminalOutput(t, 'two ', hidden);
    writeTerminalOutput(t, `probe${DA1}`, hidden);
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, 'after', hidden); // joins the same backlog
    settle();
    expect(joined(t)).toBe(`one two probe${DA1}after`);
    expect(t.answers).toBe(1);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('ten query chunks in one tick produce one flush, answered in order and once each', () => {
    const t = makeAnsweringTerminal();
    let expected = '';
    for (let i = 0; i < 10; i++) {
      const chunk = `q${i}${DA1}`;
      expected += chunk;
      writeTerminalOutput(t, chunk, hidden);
    }
    settle();
    expect(t.writes).toEqual([expected]);
    expect(t.answers).toBe(10);
    vi.advanceTimersByTime(60_000);
    expect(t.writes).toHaveLength(1);
  });

  it('a chunk without a query stays retained', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, '\x1b[2 q\x1b[3S\x1b[>5u frame\x05', hidden);
    vi.advanceTimersByTime(60_000);
    expect(t.writes).toEqual([]);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('retention resumes after a query flush', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, DA1, hidden);
    settle();
    writeTerminalOutput(t, 'later', hidden);
    vi.advanceTimersByTime(60_000);
    expect(joined(t)).toBe(DA1);
    expect(getQueuedCharCount(t)).toBe(5);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('a query split across two chunks flushes once it completes', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'text\x1b[', hidden);
    settle();
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, 'c', hidden);
    settle();
    expect(joined(t)).toBe(`text${DA1}`);
    expect(t.answers).toBe(1);
  });

  it('a split query is seen even when a query flush ended mid-sequence', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `${DA1}tail\x1b]11;`, hidden);
    settle();
    expect(joined(t)).toBe(`${DA1}tail\x1b]11;`);
    writeTerminalOutput(t, '?\x07', hidden);
    settle();
    expect(joined(t)).toBe(`${DA1}tail\x1b]11;?\x07`);
  });

  it('a query split across a hide (visible start, hidden end) still flushes', () => {
    const t = makeAnsweringTerminal();
    noteTerminalInput(t);
    writeTerminalOutput(t, 'shown\x1b[', { foreground: true, retainWhenHidden: true });
    expect(joined(t)).toBe('shown\x1b[');
    writeTerminalOutput(t, 'c', hidden);
    settle();
    expect(joined(t)).toBe(`shown${DA1}`);
    expect(t.answers).toBe(1);
  });

  it('a query whose start went straight to xterm (resync repaint tail) is still seen', () => {
    const t = makeAnsweringTerminal();
    discardTerminalOutput(t); // the resync drops the splitter with the backlog
    t.write('repaint\x1b['); // owner writes the held tail directly
    noteTerminalDirectWrite(t, 'repaint\x1b[');
    writeTerminalOutput(t, 'c', hidden);
    settle();
    expect(joined(t)).toBe(`repaint${DA1}`);
    expect(t.answers).toBe(1);
  });

  it('a long unfinished payload does not hide a later query', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `\x1b]52;c;${'A'.repeat(10_000)}`, hidden);
    writeTerminalOutput(t, `${'B'.repeat(10_000)}\x07text`, hidden);
    settle();
    expect(t.writes).toEqual([]);
    writeTerminalOutput(t, DA1, hidden);
    settle();
    expect(t.answers).toBe(1);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('live query bytes reach xterm unmuted even when the last writer was the replay writer', () => {
    const t = makeAnsweringTerminal();
    const replayed: string[] = [];
    const replayWrite = (data: string) => replayed.push(data);
    writeTerminalOutput(t, 'history', { ...hidden, write: replayWrite });
    writeTerminalOutput(t, DA1, hidden);
    settle();
    expect(replayed).toEqual(['history']);
    expect(t.writes).toEqual([DA1]);
    expect(t.answers).toBe(1);
  });

  it('a dirty pane drops the query chunk like any other hidden bytes', () => {
    const t = makeAnsweringTerminal();
    markTerminalDirty(t);
    writeTerminalOutput(t, DA1, hidden);
    settle();
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('bytes a dirty pane dropped do not leave a stale split behind', () => {
    const t = makeAnsweringTerminal();
    markTerminalDirty(t);
    writeTerminalOutput(t, 'dropped\x1b[', hidden); // never reaches xterm
    markTerminalClean(t);
    writeTerminalOutput(t, 'c', hidden);
    settle();
    expect(t.writes).toEqual([]);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('a query chunk that overflows the cap is parsed at once, not dropped with the backlog', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'x'.repeat(MAX_QUEUE_CHARS), hidden);
    writeTerminalOutput(t, DA1, hidden);
    expect(joined(t)).toBe('x'.repeat(MAX_QUEUE_CHARS) + DA1);
    expect(t.answers).toBe(1);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('a pending query is parsed at once when the backlog overflows before its flush runs', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, DA1, hidden);
    writeTerminalOutput(t, 'x'.repeat(MAX_QUEUE_CHARS), hidden);
    expect(t.answers).toBe(1);
    expect(isTerminalDirty(t)).toBe(false);
    settle(); // the posted flush finds nothing left to do
    expect(t.writes.join('')).toBe(DA1 + 'x'.repeat(MAX_QUEUE_CHARS));
  });

  it('an overflow without a query still marks the pane dirty', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, 'x'.repeat(MAX_QUEUE_CHARS), hidden);
    writeTerminalOutput(t, 'y', hidden);
    settle();
    expect(t.writes).toEqual([]);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('a reveal flush clears the pending query, so a new hidden backlog stays retained', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, DA1, hidden);
    flushTerminalOutput(t); // shown before the task ran
    writeTerminalOutput(t, 'hidden again', hidden);
    settle();
    expect(joined(t)).toBe(DA1);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('several panes querying at once are flushed in the same task', () => {
    const a = makeAnsweringTerminal();
    const b = makeAnsweringTerminal();
    writeTerminalOutput(a, `a${DA1}`, hidden);
    writeTerminalOutput(b, `b${DA1}`, hidden);
    vi.advanceTimersToNextTimer();
    expect([a.answers, b.answers]).toEqual([1, 1]);
  });

  it('a reveal via the priority drain clears the pending query, so a new hidden backlog stays retained', () => {
    const t = makeAnsweringTerminal();
    let postedFlush: (() => void) | null = null;
    __setQueryFlushPosterForTests((run) => { postedFlush = run; });
    writeTerminalOutput(t, DA1, hidden);
    promoteTerminalToPriorityDrain(t); // shown before the flush task ran
    vi.advanceTimersByTime(20); // the priority drain delivers the query
    expect(t.answers).toBe(1);
    writeTerminalOutput(t, 'hidden again', hidden);
    (postedFlush as (() => void) | null)?.(); // the late task finds nothing to do
    expect(joined(t)).toBe(DA1);
    expect(isTerminalRetained(t)).toBe(true);
  });

  it('showing the pane before the flush runs leaves the backlog to the normal path, answered once', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `boot${DA1}`, hidden);
    // Reveal inside the window: the owner flushes the retained backlog.
    flushTerminalOutput(t);
    expect(t.answers).toBe(1);
    settle();
    noteTerminalInput(t);
    writeTerminalOutput(t, 'shown', { foreground: true, retainWhenHidden: true });
    vi.runAllTimers();
    expect(joined(t)).toBe(`boot${DA1}shown`);
    expect(t.answers).toBe(1);
  });

  it('a sync frame opened after the query (pane shown) keeps its hold; its release drains in order', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `old${DA1}`, hidden);
    // Pane shown inside the window; the TUI opens a DEC 2026 frame.
    writeTerminalOutput(t, '\x1b[?2026hframe', { foreground: true, retainWhenHidden: true });
    settle();
    expect(t.writes).toEqual([]); // the query flush does not break the open frame
    writeTerminalOutput(t, 'end\x1b[?2026l', { foreground: true, retainWhenHidden: true });
    vi.runAllTimers();
    expect(joined(t)).toBe(`old${DA1}\x1b[?2026hframeend\x1b[?2026l`);
    expect(t.answers).toBe(1);
  });

  it('showing the pane afterwards does not answer the query a second time', () => {
    const t = makeAnsweringTerminal();
    writeTerminalOutput(t, `boot${DA1}`, hidden);
    settle();
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
      for (let i = 0; i < 5; i++) {
        writeTerminalOutput(t, DA1, { ...hidden, ptyId: 'daemon-1' });
        settle();
      }
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('query-parse'));
      expect(lines).toEqual(['[wmux:hidden-retention] query-parse ptyId=daemon-1 chars=3']);
    } finally {
      log.mockRestore();
    }
  });
});

describe('terminalOutputScheduler — query flush task (default poster)', () => {
  beforeEach(() => __resetTerminalOutputSchedulerForTests());
  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it('runs the flush in a posted task, not on a timer (timers throttle in a hidden window)', async () => {
    // setTimeout is frozen: only a non-timer task can deliver the flush.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = makeTerminal();
    writeTerminalOutput(t, 'x\x1b[c', { foreground: false, retainWhenHidden: true });
    expect(t.writes).toEqual([]);
    for (let i = 0; i < 50 && t.writes.length === 0; i++) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect(joined(t)).toBe('x\x1b[c');
  });
});
