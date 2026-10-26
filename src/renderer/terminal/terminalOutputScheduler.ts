// Global terminal output scheduler — one cooperative drain loop for ALL panes.
//
// RCA (2026-07-10 multi-workspace stutter): every workspace's pane tree stays
// mounted (tmux-style persistence), and useTerminal wrote PTY data straight
// into each pane's xterm on every IPC event. xterm's internal WriteBuffer
// schedules parse/render callbacks PER TERMINAL, so N busy hidden agents run
// N independent write pipelines on the shared renderer thread and the focused
// pane's input echo and paint starve between them. Repaint-side work (#333)
// cannot fix this — the contention is in the write/parse path.
//
// This module serializes all pane writes through a single budgeted drain:
//
//   - Visible pane, empty queue, bounded chunk → DIRECT write (byte-identical
//     to the old path; the focused pane pays zero added latency in steady
//     state).
//   - Visible pane, queued bytes OR one oversized chunk → enqueue as priority
//     + drain(0), so per-terminal byte order is never violated AND a visible
//     pane's OWN output flood (e.g. the agent you are watching printing a
//     torrent) is chunked under the drain budget instead of blocking the
//     renderer in a single parse.
//   - Hidden pane → enqueue; drained in the background cadence.
//   - Drain tick: at most MAX_WRITES_PER_DRAIN hand-offs of CHUNK_CHARS each
//     under a hard DRAIN_TIME_BUDGET_MS wall-clock budget, priority entries
//     first, round-robin across terminals.
//
// NOTHING is ever dropped. On overflow (a hidden pane flooding past
// MAX_QUEUE_CHARS) the queue is flushed straight into xterm — that is exactly
// the pre-scheduler behavior, so the worst case degrades to the old baseline
// instead of losing output. (A lossy cap needs a main-side screen mirror to
// rehydrate from; that is a separate, later stage.)
//
// Phase 3 (hidden-pane retention, opt-in via WriteOptions.retainWhenHidden):
// the batching above still PARSES every hidden byte eventually, which is the
// measured bottleneck (hiddenFlood bench: 4 hidden flooders drag the visible
// pane to 8-20fps even with batching). Retention mode changes the hidden
// policy to "queue but never drain" — the renderer parses nothing for hidden
// panes. On overflow the backlog is discarded and the terminal marked DIRTY;
// dirtiness is the caller's signal to re-synchronize the full screen state
// from the source of truth (the daemon session's RingBuffer) on reveal or
// before a buffer read. This is safe precisely because daemon sessions retain
// the authoritative bytes — which is why the option is only set for
// daemon-backed panes (see useTerminal).
//
// Retention exception — terminal queries: xterm is the pane's only responder,
// so a DA/DSR/CPR/kitty `CSI ? u`/OSC color query sitting in a never-parsed
// backlog went unanswered while the pane stayed hidden (a TUI started in a
// background workspace gave up on its probes, e.g. Claude Code never enabled
// the kitty keyboard). A retained chunk that completes a query flushes the
// whole backlog in the next task (so a burst of query chunks costs one parse)
// and xterm answers in order with its real state.
// Dirty panes (overflowed backlog, bytes dropped) are not covered: their
// queries are answered by nothing until the reveal resync, which strips them.

import { IncompleteEscapeSplitter, splitIncompleteEscape } from '../../shared/incompleteEscape';
import { containsTerminalQuery } from '../../shared/replayQuerySanitizer';

/** Minimal surface the scheduler needs — keeps the module xterm-agnostic and
 *  unit-testable with plain fakes. */
export interface SchedulableTerminal {
  write(data: string): void;
}

interface WriteOptions {
  /** Pane visibility at receive time. Visible panes keep the old direct-write
   *  latency; hidden panes get batched. */
  foreground: boolean;
  /** Phase 3: hidden bytes are queued but NEVER drained (zero hidden parsing).
   *  Overflow discards the backlog and marks the terminal dirty instead of
   *  flushing into xterm. Only valid for panes whose full state can be
   *  re-synchronized from an external source of truth (daemon RingBuffer). */
  retainWhenHidden?: boolean;
  /** Fires with the char count each time bytes are actually handed to
   *  terminal.write (glyph-repaint cadence tracks WRITE calls, not IPC
   *  receipt — see glyphRepaint.ts header). */
  onWritten?: (chars: number) => void;
  /** Optional hand-off used when these bytes need parse-scoped behavior.
   *  Queued chunks retain whether they need this writer, while the queue entry
   *  keeps the latest mount's function so parked terminals can be adopted
   *  without retaining a stale closure. For replay-provenance bytes, this
   *  writer MUST apply replay-scoped control-sequence muting. */
  write?: (data: string) => void;
  /** Diagnostic label for logs (the pane's pty id). */
  ptyId?: string;
}

interface QueuedChunk {
  data: string;
  customWrite: boolean;
}

interface QueueEntry {
  terminal: SchedulableTerminal;
  /** Queued segments in arrival order. Consumed via chunkIndex to avoid
   *  O(n²) shift() on long queues; compacted periodically. */
  chunks: QueuedChunk[];
  chunkIndex: number;
  queuedChars: number;
  /** True when foreground bytes are queued (visible pane briefly behind) —
   *  drained ahead of background entries and at the faster cadence. */
  priority: boolean;
  /** Phase 3 retention: entry holds hidden bytes that must NOT be drained by
   *  the background cadence. Cleared the moment a foreground write arrives
   *  (pane became visible → normal priority catch-up drains the backlog). */
  retained: boolean;
  /** True while this entry's chunks are held behind an open DEC 2026
   *  synchronized-output frame. Like `retained`, held entries are invisible to
   *  the drain loop — they are released (drained once) on the frame's END
   *  marker or the hold safety timeout, never by another terminal's drain. */
  heldForSync: boolean;
  onWritten?: (chars: number) => void;
  /** Latest mount's custom writer. Retained chunks store only a boolean tag. */
  customWrite?: (data: string) => void;
}

// Cadence: hidden output is invisible, so its first hand-off can wait a
// batch window; the drain itself stays on a frame-ish rhythm with a hard
// wall-clock budget so xterm parsing can never pin the renderer thread.
const BACKGROUND_FLUSH_DELAY_MS = 50;
const DRAIN_INTERVAL_MS = 16;
const PRIORITY_DRAIN_INTERVAL_MS = 4;
const CHUNK_CHARS = 16 * 1024;
// A single foreground write larger than this is routed through the batch path
// (chunked under the drain budget) rather than written directly, so a visible
// pane's own output flood cannot pin the renderer in one oversized parse.
// Sized above ordinary keystroke echo and TUI redraws so those keep the
// zero-latency direct path; only genuine torrents cross it.
const FOREGROUND_DIRECT_MAX_CHARS = 64 * 1024;
const MAX_WRITES_PER_DRAIN = 2;
// A visible pane with queued output gets a higher per-drain write budget so its
// backlog (streaming that fell outside the interactive window) catches up fast
// under the SAME 8ms wall-clock ceiling — matching orca's high-priority budget
// (8 × 16KB = 128KB/tick). Without this, foreground streaming demoted into the
// queue would drain at only 2 writes/tick and lag.
const PRIORITY_MAX_WRITES_PER_DRAIN = 8;
const DRAIN_TIME_BUDGET_MS = 8;
// Interactive window: keystroke echo and input-driven TUI redraws arrive within
// a short window after the user types. ONLY output inside this window keeps the
// zero-latency DIRECT write. Streaming output with no recent input (an agent
// printing a torrent, a log tail) is queued and budget-coordinated so multiple
// active terminals can't each pin the renderer thread in an unbudgeted parse and
// starve input/switch/paint — the "switching lags when terminals are active,
// smooth when idle" symptom. Sized above ordinary echo round-trip latency.
const INTERACTIVE_WINDOW_MS = 150;
/** Backlogs past this promote the drain to the priority cadence so a single
 *  chatty hidden pane cannot sit on a growing queue for seconds. */
const LARGE_BACKLOG_CHARS = 512 * 1024;
/** Bounded scheduler memory. Overflow flushes the whole queue into xterm —
 *  the pre-scheduler baseline — rather than dropping bytes. */
const MAX_QUEUE_CHARS = 2 * 1024 * 1024;
/** Compact consumed chunk slots once the dead prefix grows past this. */
const COMPACT_THRESHOLD = 64;

// DEC private mode 2026 — synchronized output. A TUI (Claude Code, Codex,
// anything on Ratatui/Textual) wraps a full-screen repaint in BEGIN…END so a
// conforming terminal presents the frame atomically instead of painting every
// intermediate cursor move. Public spec:
//   https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
// We hold a visible pane's foreground output OUT of xterm while a frame is open
// (no parse, no raster) and release it once on END, so Chromium rasters once
// per TUI frame instead of once per intermediate chunk. This is the fix for the
// GPU repaint-burst that starves input under an agent flood (typing lag, Hangul
// IME composition truncation, paste truncation).
const SYNC_OUTPUT_BEGIN = '\x1b[?2026h';
const SYNC_OUTPUT_END = '\x1b[?2026l';
// If the END marker never lands (ConPTY can split it across PTY deliveries, or
// an agent can simply misbehave) the hold is released anyway after a bounded
// safety window so a pane can never wedge mid-frame. A PTY read can also split
// a CUP (`ESC[row;colH`) at that same boundary; the release peels the
// unfinished CSI into `escapeCarry` so the synthetic END cannot abort it.
const SYNC_HOLD_SAFETY_MS = 250;
// A frame opened right after a keystroke is echo / input-driven redraw the user
// is waiting on. Release it on a near-frame deadline so typing and IME
// composition never queue behind a held frame — this is what keeps input
// responsive while an agent's autonomous output coalesces on the slow window.
const SYNC_HOLD_INTERACTIVE_SAFETY_MS = 32;

const queue = new Map<SchedulableTerminal, QueueEntry>();
/** Last user-input timestamp per terminal. The interactive window after this
 *  keeps the terminal's foreground output on the direct-write path (echo /
 *  input-driven redraw); output with no recent input is queued + coordinated. */
const lastInputAt = new Map<SchedulableTerminal, number>();
/** Terminals whose retained backlog overflowed and was discarded — their
 *  parsed buffer no longer reflects the PTY stream. The owner (useTerminal)
 *  re-synchronizes from the daemon and calls markTerminalClean. While dirty,
 *  further retained bytes are dropped outright (they are re-obtainable from
 *  the daemon RingBuffer; queueing them would just re-overflow). */
const dirtyTerminals = new Set<SchedulableTerminal>();
/** Per-terminal DEC 2026 synchronized-output frame state. Present only while a
 *  frame is open or its release is pending. `interactive` is latched at the
 *  open transition so the safety deadline reflects whether the user was typing
 *  when the frame began, not when it (maybe never) closes. */
interface SyncFrameState {
  open: boolean;
  interactive: boolean;
  safetyTimer: ReturnType<typeof setTimeout> | null;
}
const syncFrames = new Map<SchedulableTerminal, SyncFrameState>();
/** Unfinished ESC/CSI/OSC peeled off a held 2026 frame before a synthetic END
 *  is injected, then prepended to the next write so xterm never sees END's ESC
 *  abort a pending CUP. Keyed by terminal, not the queue entry — the safety
 *  drain deletes the entry. */
const escapeCarry = new Map<SchedulableTerminal, string>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainDelayMs: number | null = null;
/** One-shot diagnostic latch — see the retention branch in writeTerminalOutput. */
let retentionEngagedLogged = false;
/** Per-terminal escape state over every write of a retention-enabled pane,
 *  visible or hidden, in arrival order — so a query split across two chunks
 *  (`ESC[` | `c`), even across a hide, is seen once it completes. Outlives the
 *  queue entry: a query flush deletes the entry, while xterm's parser holds the
 *  same unfinished tail the splitter does. */
const querySplitters = new Map<SchedulableTerminal, IncompleteEscapeSplitter>();
/** Queries are short; a longer unfinished sequence is a payload (image, OSC 52)
 *  and its held copy is dropped instead of duplicating the queued bytes. */
const QUERY_SPLITTER_MAX_HELD = 4096;
/** Rate limit for the query-parse log: a TUI that sends CPR every frame
 *  re-parses its hidden pane every frame — visible in the log, not flooding it. */
const QUERY_PARSE_LOG_INTERVAL_MS = 10_000;
const queryParseLog = new Map<SchedulableTerminal, { lastAt: number; suppressed: number }>();
/** Terminals with a query waiting in their retained backlog → log label.
 *  Query flushes run in the next macrotask: every query chunk that lands
 *  before it joins the same flush, so a burst costs one parse, not one per
 *  chunk. The task is a MessageChannel post, not a timer: Chromium stretches
 *  even setTimeout(0) to about a second in a minimized or occluded window,
 *  which is when background panes start agents, and their probes time out. */
const pendingQueryFlushes = new Map<SchedulableTerminal, string | undefined>();
let queryFlushPosted = false;
let queryFlushChannel: MessageChannel | null = null;
let queryFlushPosterForTests: ((run: () => void) => void) | null = null;

/** Monotonic-ish clock for the interactive window. Falls back to Date.now() in
 *  environments without `performance` (jsdom-less unit tests). */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Record user input for a terminal. Call from the xterm onData handler. The
 *  interactive window after this keeps the terminal's foreground output on the
 *  zero-latency direct path (keystroke echo, input-driven TUI redraw); output
 *  with no recent input is queued and budget-coordinated so active terminals
 *  don't starve input/switch/paint. */
export function noteTerminalInput(terminal: SchedulableTerminal): void {
  lastInputAt.set(terminal, now());
}

/** True when the user typed into this terminal within the interactive window —
 *  i.e. this foreground output is likely echo/redraw and should stay direct. */
function withinInteractiveWindow(terminal: SchedulableTerminal): boolean {
  const t = lastInputAt.get(terminal);
  return t !== undefined && now() - t < INTERACTIVE_WINDOW_MS;
}

/** Arm the shared drain timer, keeping the EARLIEST pending deadline. One timer
 *  serves every queued terminal, so a later request must never push out a drain
 *  that was already due sooner. */
function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    // Keep the earlier deadline; only reschedule when the new request is sooner.
    if (drainDelayMs !== null && drainDelayMs <= delayMs) return;
    clearTimeout(drainTimer);
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs);
  drainDelayMs = delayMs;
}

/** Fetch this terminal's queue entry, creating an empty one on first write.
 *  Mount-owned callbacks are re-bound on every applicable call so a parked
 *  terminal never drains through stale closures after adoption. */
function getOrCreateEntry(
  terminal: SchedulableTerminal,
  options: WriteOptions,
): QueueEntry {
  let entry = queue.get(terminal);
  if (!entry) {
    entry = { terminal, chunks: [], chunkIndex: 0, queuedChars: 0, priority: false, retained: false, heldForSync: false };
    queue.set(terminal, entry);
  }
  // Latest registration wins — the hook closure belongs to the current mount.
  entry.onWritten = options.onWritten;
  if (options.write) entry.customWrite = options.write;
  return entry;
}

/** Rebind retained custom chunks to the mount that currently owns `terminal`.
 *  Replay-provenance chunks depend on this writer applying replay-scoped
 *  control-sequence muting; callers must not bind a plain terminal writer. */
export function rebindTerminalOutputWriter(
  terminal: SchedulableTerminal,
  write: (data: string) => void,
): void {
  const entry = queue.get(terminal);
  if (entry) entry.customWrite = write;
}

/** Drop already-consumed chunks so a long-lived queue doesn't grow without
 *  bound. Fully drained → reset outright; otherwise splice only once the
 *  consumed prefix passes COMPACT_THRESHOLD, so a steady stream pays the
 *  O(n) splice rarely instead of on every drain. */
function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === entry.chunks.length) {
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
  } else if (entry.chunkIndex >= COMPACT_THRESHOLD) {
    entry.chunks.splice(0, entry.chunkIndex);
    entry.chunkIndex = 0;
  }
}

/** Take up to `limit` chars off the head of the queue, preserving order. */
function takeQueuedChunk(entry: QueueEntry, limit: number): QueuedChunk | null {
  let data = '';
  let remaining = limit;
  let customWrite: boolean | undefined;
  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex];
    if (data && chunk.customWrite !== customWrite) break;
    customWrite = chunk.customWrite;
    if (chunk.data.length <= remaining) {
      data += chunk.data;
      remaining -= chunk.data.length;
      entry.queuedChars -= chunk.data.length;
      entry.chunkIndex += 1;
    } else {
      data += chunk.data.slice(0, remaining);
      chunk.data = chunk.data.slice(remaining);
      entry.queuedChars -= remaining;
      remaining = 0;
    }
  }
  compactConsumedChunks(entry);
  return data ? { data, customWrite: customWrite ?? false } : null;
}

/** True when this entry still holds unconsumed output. Reads the cursor rather
 *  than `chunks.length` because consumed chunks linger until compaction. */
function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length;
}

/** Hand one bounded chunk to xterm. Returns false when the terminal is gone
 *  (disposed mid-flight) and the entry should be abandoned. */
function writeQueuedChunk(entry: QueueEntry): boolean {
  const chunk = takeQueuedChunk(entry, CHUNK_CHARS);
  if (!chunk) return true;
  const customWrite = chunk.customWrite ? entry.customWrite : undefined;
  if (chunk.customWrite && !customWrite) {
    // This is an internal invariant failure, not the routine dispose race
    // below. Fail closed: replay bytes must never fall back to an unmuted
    // terminal.write, and make the dropped backlog visible in dogfood logs.
    console.error(
      `[wmux:terminal-output] custom replay writer is unbound; dropping ${entry.queuedChars + chunk.data.length} queued chars`,
    );
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
    entry.queuedChars = 0;
    return false;
  }
  try {
    if (customWrite) {
      customWrite(chunk.data);
    } else {
      entry.terminal.write(chunk.data);
    }
    entry.onWritten?.(chunk.data.length);
    return true;
  } catch {
    // terminal.dispose() raced a queued late chunk. Drop this entry only —
    // the scheduler must keep draining the other panes.
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
    entry.queuedChars = 0;
    return false;
  }
}

/** An entry the drain loop must ignore: retained (hidden, never parsed) or
 *  held behind an open DEC 2026 synchronized-output frame. Both sit in the
 *  queue only to preserve byte order until their own release path drains them. */
function isUndrainable(entry: QueueEntry): boolean {
  return entry.retained || entry.heldForSync;
}

/** True when some drainable entry justifies the fast drain cadence — either an
 *  explicitly promoted (visible/focused) terminal or one whose backlog has grown
 *  past LARGE_BACKLOG_CHARS. Undrainable entries are skipped on purpose: an
 *  entry that will not be written must not speed up the timer it can't consume. */
function hasPriorityBacklog(): boolean {
  for (const entry of queue.values()) {
    if (isUndrainable(entry)) continue; // never drained — must not drive the cadence
    if (entry.priority || entry.queuedChars > LARGE_BACKLOG_CHARS) return true;
  }
  return false;
}

/** True when at least one entry is eligible for the drain loop. Retained /
 *  sync-held entries sit in the queue for ordering purposes only. */
function hasDrainableEntries(): boolean {
  for (const entry of queue.values()) {
    if (!isUndrainable(entry)) return true;
  }
  return false;
}

/** Pick the next entry to drain: priority entries first, otherwise Map
 *  insertion order. Removing + re-inserting after a partial drain rotates the
 *  entry to the tail, which is what gives round-robin fairness. Retained /
 *  sync-held entries are invisible to the drain loop. */
function takeNextEntry(): QueueEntry | null {
  let fallback: QueueEntry | null = null;
  for (const entry of queue.values()) {
    if (isUndrainable(entry)) continue;
    if (entry.priority) {
      queue.delete(entry.terminal);
      return entry;
    }
    fallback ??= entry;
  }
  if (fallback) queue.delete(fallback.terminal);
  return fallback;
}

/**
 * The drain tick: hand bounded chunks to xterm under both a write-count budget
 * and a wall-clock budget, then re-arm if work remains.
 *
 *   scheduleDrain(delay) ──► drainQueuedOutput()
 *                              │
 *                              ├─ takeNextEntry() ──► writeQueuedChunk()
 *                              │        ▲                    │
 *                              │        └── round-robin ─────┘
 *                              │
 *                              └─ work left? ──► scheduleDrain(next cadence)
 *
 * Two budgets, because either alone leaks: the write count bounds a queue of
 * many small chunks, the elapsed check bounds a few pathologically large ones.
 * Whichever trips first yields the main thread back to input and paint.
 */
function drainQueuedOutput(): void {
  drainTimer = null;
  drainDelayMs = null;
  const startedAt = now();
  let writes = 0;
  // Foreground/priority backlog drains at the higher write budget so demoted
  // visible streaming catches up fast; background stays at the small budget.
  const maxWrites = hasPriorityBacklog() ? PRIORITY_MAX_WRITES_PER_DRAIN : MAX_WRITES_PER_DRAIN;

  while (hasDrainableEntries() && writes < maxWrites) {
    const entry = takeNextEntry();
    if (!entry) break;
    if (writeQueuedChunk(entry)) {
      writes += 1;
      if (hasQueuedChunks(entry)) {
        queue.set(entry.terminal, entry); // rotate to tail, keep remainder
      } else {
        entry.priority = false;
      }
    }
    // Cooperative: xterm parsing shares the renderer thread with input and
    // paint. One over-budget tick yields; the reschedule below continues.
    if (writes > 0 && now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }

  if (hasDrainableEntries()) {
    scheduleDrain(hasPriorityBacklog() ? PRIORITY_DRAIN_INTERVAL_MS : DRAIN_INTERVAL_MS);
  }
}

/** Resolve a terminal's DEC 2026 frame state after one foreground chunk.
 *  Multiple markers in a chunk are resolved by honoring the LAST one.
 *
 *  Split-marker behavior:
 *  - A BEGIN split across a chunk boundary is not matched here, so the frame
 *    never engages the hold and that frame simply renders un-coalesced — the
 *    pre-feature behavior, no worse than today.
 *  - An END split while a frame is open is likewise not matched, but the hold
 *    is bounded by the absolute safety deadline (armed at open, never pushed
 *    back), so the pane is released regardless.
 *  - A CUP/OSC split at that same deadline is NOT benign: injecting END while
 *    the hold ends on `ESC[` aborts the CSI and paints `12;6H` as glyphs.
 *    `closeHeldFrameWithSyntheticEnd` peels the unfinished tail into
 *    `escapeCarry` and prepends it to the next write. */
function resolveSyncOpen(prevOpen: boolean, data: string): boolean {
  const lastBegin = data.lastIndexOf(SYNC_OUTPUT_BEGIN);
  const lastEnd = data.lastIndexOf(SYNC_OUTPUT_END);
  if (lastBegin === -1 && lastEnd === -1) return prevOpen;
  return lastBegin > lastEnd;
}

/** Run the coalesced query flushes. Only a still-retained entry is flushed
 *  here: if the pane was shown meanwhile, its foreground write cleared
 *  `retained` and the priority drain (or an open DEC 2026 frame's release)
 *  already owns the backlog, query included, in order. An entry that is gone
 *  was flushed, discarded or overflowed to dirty. */
function runQueryFlushes(): void {
  queryFlushPosted = false;
  // One terminal per task: several hidden panes querying at once must not
  // parse all their backlogs in one task and block input for the visible pane.
  const next = pendingQueryFlushes.entries().next();
  if (next.done) return;
  const [terminal, ptyId] = next.value;
  pendingQueryFlushes.delete(terminal);
  if (pendingQueryFlushes.size > 0) postQueryFlush();
  const entry = queue.get(terminal);
  if (!entry || !entry.retained || !hasQueuedChunks(entry)) return;
  logQueryParse(terminal, ptyId, entry.queuedChars);
  flushTerminalOutput(terminal);
}

function postQueryFlush(): void {
  if (queryFlushPosted) return;
  queryFlushPosted = true;
  if (queryFlushPosterForTests) {
    queryFlushPosterForTests(runQueryFlushes);
    return;
  }
  if (typeof MessageChannel === 'undefined') {
    setTimeout(runQueryFlushes, 0);
    return;
  }
  if (!queryFlushChannel) {
    queryFlushChannel = new MessageChannel();
    queryFlushChannel.port1.onmessage = runQueryFlushes;
    // Node keeps a port with a listener alive; Chromium has no unref.
    (queryFlushChannel.port1 as { unref?: () => void }).unref?.();
  }
  queryFlushChannel.port2.postMessage(null);
}

/** Test only: run query flushes through `post` (e.g. fake timers) instead of
 *  the MessageChannel task; null restores the default. */
export function __setQueryFlushPosterForTests(post: ((run: () => void) => void) | null): void {
  queryFlushPosterForTests = post;
}

function feedQuerySplitter(terminal: SchedulableTerminal, data: string): string {
  let splitter = querySplitters.get(terminal);
  if (!splitter) {
    splitter = new IncompleteEscapeSplitter(QUERY_SPLITTER_MAX_HELD);
    querySplitters.set(terminal, splitter);
  }
  return splitter.push(data);
}

/** The owner wrote `data` straight into xterm, bypassing this scheduler (the
 *  resync repaint). Keeps the query splitter in step with xterm's parser, so a
 *  query whose start went in that way is still seen when its end arrives. */
export function noteTerminalDirectWrite(terminal: SchedulableTerminal, data: string): void {
  feedQuerySplitter(terminal, data);
}

function scheduleQueryFlush(terminal: SchedulableTerminal, ptyId: string | undefined): void {
  pendingQueryFlushes.set(terminal, ptyId);
  postQueryFlush();
}

function logQueryParse(terminal: SchedulableTerminal, ptyId: string | undefined, chars: number): void {
  const t = now();
  const state = queryParseLog.get(terminal);
  if (state && t - state.lastAt < QUERY_PARSE_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  queryParseLog.set(terminal, { lastAt: t, suppressed: 0 });
  console.log(
    `[wmux:hidden-retention] query-parse ptyId=${ptyId ?? '?'} chars=${chars}` +
      (suppressed > 0 ? ` (+${suppressed} since last log)` : ''),
  );
}

/** Tear down a terminal's sync-frame tracking (state + safety timer). */
function clearSyncFrame(terminal: SchedulableTerminal): void {
  const state = syncFrames.get(terminal);
  if (!state) return;
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  syncFrames.delete(terminal);
}

/** Concat remaining queued bytes, peel a trailing unfinished escape into
 *  `escapeCarry`, and leave only the complete prefix in the entry. */
function peelIncompleteEscape(terminal: SchedulableTerminal, entry: QueueEntry): boolean {
  let data = '';
  let customWrite = false;
  for (let i = entry.chunkIndex; i < entry.chunks.length; i++) {
    customWrite = entry.chunks[i].customWrite;
    data += entry.chunks[i].data;
  }
  const { complete, pending } = splitIncompleteEscape(data);
  if (pending) {
    const prev = escapeCarry.get(terminal) ?? '';
    escapeCarry.set(terminal, prev + pending);
  }
  entry.chunks = complete ? [{ data: complete, customWrite }] : [];
  entry.chunkIndex = 0;
  entry.queuedChars = complete.length;
  return customWrite;
}

/** Close xterm's native 2026 hold with a synthetic END. A later real END is a
 *  harmless no-op. The unfinished CSI tail (if any) is carried, not written
 *  before END — otherwise END's ESC aborts it and the CUP body paints as text. */
function closeHeldFrameWithSyntheticEnd(terminal: SchedulableTerminal, entry: QueueEntry): void {
  const customWrite = peelIncompleteEscape(terminal, entry);
  entry.chunks.push({ data: SYNC_OUTPUT_END, customWrite });
  entry.queuedChars += SYNC_OUTPUT_END.length;
}

function releaseHeldWithSyntheticEnd(terminal: SchedulableTerminal, entry: QueueEntry): void {
  clearSyncFrame(terminal);
  entry.heldForSync = false;
  entry.priority = true;
  closeHeldFrameWithSyntheticEnd(terminal, entry);
  scheduleDrain(0);
}

/** Arm the bounded safety timer ONCE, at frame open. The deadline is absolute
 *  from open (never pushed back by body chunks — otherwise a frame that streams
 *  faster than the deadline would never time out and the pane could stay blank
 *  until the overflow cap) and short when the frame opened while the user was
 *  typing (echo/redraw must not wait) and longer otherwise. */
function armSyncSafety(terminal: SchedulableTerminal): void {
  const state = syncFrames.get(terminal);
  if (!state) return;
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  const delay = state.interactive ? SYNC_HOLD_INTERACTIVE_SAFETY_MS : SYNC_HOLD_SAFETY_MS;
  state.safetyTimer = setTimeout(() => {
    // END never landed within the window (split marker, streaming inside an
    // unclosed frame, or a misbehaving agent). Release so the pane can never
    // wedge mid-frame, and close xterm's sync mode with a synthetic END.
    const entry = queue.get(terminal);
    if (!entry) {
      clearSyncFrame(terminal);
      return;
    }
    releaseHeldWithSyntheticEnd(terminal, entry);
  }, delay);
}

/** Queue a chunk behind an open synchronized frame without draining it. */
function holdForSyncFrame(
  terminal: SchedulableTerminal,
  data: string,
  options: WriteOptions,
  justOpened: boolean,
): void {
  if (justOpened) {
    clearSyncFrame(terminal);
    syncFrames.set(terminal, {
      open: true,
      interactive: withinInteractiveWindow(terminal),
      safetyTimer: null,
    });
  }
  const entry = getOrCreateEntry(terminal, options);
  entry.retained = false;
  entry.priority = true;
  entry.heldForSync = true;
  entry.chunks.push({ data, customWrite: options.write !== undefined });
  entry.queuedChars += data.length;
  if (entry.queuedChars > MAX_QUEUE_CHARS) {
    // A single frame ballooned past the cap (never-closing frame / runaway
    // agent). Stop holding and hand everything to xterm now (bounded memory
    // over perfect coalescing) — closing xterm's sync mode with a synthetic
    // END so the unmatched BEGIN cannot leave it held.
    releaseHeldWithSyntheticEnd(terminal, entry);
    return;
  }
  // Absolute deadline: arm exactly once, at open. Body chunks must NOT re-arm.
  if (justOpened) armSyncSafety(terminal);
}

/** Frame closed: enqueue the closing chunk and drain the held backlog once, so
 *  xterm rasters the completed frame a single time. */
function releaseSyncFrame(
  terminal: SchedulableTerminal,
  data: string,
  options: WriteOptions,
): void {
  clearSyncFrame(terminal);
  const entry = getOrCreateEntry(terminal, options);
  entry.retained = false;
  entry.heldForSync = false;
  entry.priority = true;
  entry.chunks.push({ data, customWrite: options.write !== undefined });
  entry.queuedChars += data.length;
  if (entry.queuedChars > MAX_QUEUE_CHARS) {
    flushTerminalOutput(terminal);
    return;
  }
  scheduleDrain(0);
}

/**
 * Route one PTY data event into a terminal.
 *
 * Visible pane with nothing queued → direct write (identical to the
 * pre-scheduler path). Anything else is enqueued so per-terminal byte order
 * is always preserved, and drained on the appropriate cadence.
 */
export function writeTerminalOutput(
  terminal: SchedulableTerminal,
  data: string,
  options: WriteOptions,
): void {
  // Fed before the carry is prepended: the carry is bytes it has already seen.
  // Not fed with hidden bytes a dirty pane drops: xterm never sees those.
  let completed = '';
  if (options.retainWhenHidden) {
    if (options.foreground || !dirtyTerminals.has(terminal)) {
      // Only completed sequences: a query is flushed once all of it is queued.
      completed = feedQuerySplitter(terminal, data);
    }
  } else {
    querySplitters.delete(terminal);
  }
  const carried = escapeCarry.get(terminal);
  if (carried) {
    data = carried + data;
    escapeCarry.delete(terminal);
  }
  if (!data) return;

  // Phase 3 retention: hidden bytes are queued for ordering but never drained
  // — the renderer does zero parsing for hidden panes. Overflow discards the
  // backlog and marks the terminal dirty (the owner re-syncs from the daemon
  // on reveal / before a read); while dirty, further hidden bytes are dropped
  // outright. NOTE: an exit-marker line written by useTerminal after an
  // overflow is lost with the backlog — the daemon resync replays the PTY's
  // real final output instead.
  if (!options.foreground && options.retainWhenHidden) {
    if (dirtyTerminals.has(terminal)) return;
    // A pane going hidden mid-frame abandons any open sync hold: retention now
    // owns its bytes, and the safety timer would otherwise fire into a hidden
    // pane.
    clearSyncFrame(terminal);
    const entry = getOrCreateEntry(terminal, options);
    entry.heldForSync = false;
    if (!entry.retained) {
      entry.retained = true;
      if (!retentionEngagedLogged) {
        retentionEngagedLogged = true;
        // One-shot diagnostic (mirrored into the main log): confirms the
        // retention policy is live in this session — the dogfood signal that
        // hidden bytes are being held, not parsed.
        console.log('[wmux:hidden-retention] engaged — hidden pane output retained without parsing');
      }
    }
    entry.chunks.push({ data, customWrite: options.write !== undefined });
    entry.queuedChars += data.length;
    const queryInBacklog = pendingQueryFlushes.has(terminal) || containsTerminalQuery(completed);
    if (entry.queuedChars > MAX_QUEUE_CHARS && queryInBacklog) {
      // Dropping this backlog would drop a query nothing else will answer
      // (the reveal resync strips queries). Parse it now instead: bounded
      // memory, and the same hand-off the coalesced flush would have made.
      logQueryParse(terminal, options.ptyId, entry.queuedChars);
      flushTerminalOutput(terminal);
      return;
    }
    if (entry.queuedChars > MAX_QUEUE_CHARS) {
      queue.delete(terminal);
      dirtyTerminals.add(terminal);
      querySplitters.delete(terminal);
      escapeCarry.delete(terminal);
      console.log(`[wmux:hidden-retention] backlog overflow (${entry.queuedChars} chars) — pane marked dirty, will resync from daemon on reveal`);
      return;
    }
    if (queryInBacklog) {
      // The app is waiting on an answer only xterm can give. Hand the whole
      // backlog over shortly, in order, so xterm answers from its real state.
      // A full flush (not a priority promote): it deletes the entry, so the
      // next hidden chunk starts a fresh retained one, where a promoted entry
      // would be re-retained by that chunk with the query still unparsed.
      // Until the task runs, later hidden chunks join the same backlog and
      // the same flush. Worst case is one parse of a backlog just under the cap.
      scheduleQueryFlush(terminal, options.ptyId);
    }
    return;
  }

  // DEC 2026 synchronized-output coalescing for VISIBLE panes. While a frame is
  // open, hold the pane's chunks out of xterm (no parse, no raster); release
  // once on END so Chromium rasters the completed frame a single time instead
  // of once per intermediate cursor move. A complete BEGIN…END inside one chunk
  // falls through (already one write / one parse) and needs no special casing.
  if (options.foreground) {
    const prevOpen = syncFrames.get(terminal)?.open ?? false;
    // Cheap gate before the two marker scans: they only matter when a frame is
    // already open (watching for END) or the chunk could contain a marker at
    // all. `includes('\x1b')` stops at the first ESC, so the common markerless
    // echo/stream chunk skips both full lastIndexOf scans.
    if (prevOpen || data.includes('\x1b')) {
      const nowOpen = resolveSyncOpen(prevOpen, data);
      if (nowOpen) {
        holdForSyncFrame(terminal, data, options, !prevOpen);
        return;
      }
      if (prevOpen) {
        releaseSyncFrame(terminal, data, options);
        return;
      }
    }
  }

  const existing = queue.get(terminal);

  // Direct path only for a bounded chunk with nothing already queued AND recent
  // user input (interactive window) — keystroke echo / input-driven TUI redraw,
  // which must stay zero-latency. Streaming output with no recent input (agent
  // torrents, log tails) falls through to the priority-enqueue path so it is
  // handed to xterm in CHUNK_CHARS slices under the shared drain budget. This is
  // the fix for multi-active-terminal starvation: without the interactive gate,
  // every visible streaming pane wrote synchronously with no shared budget, so
  // N busy visible panes pinned the renderer thread and starved input/switch.
  // Byte order stays intact — nothing was queued, so this chunk is first in line
  // and drains at the priority cadence.
  if (
    options.foreground &&
    (!existing || !hasQueuedChunks(existing)) &&
    data.length <= FOREGROUND_DIRECT_MAX_CHARS &&
    withinInteractiveWindow(terminal)
  ) {
    try {
      if (options.write) options.write(data);
      else terminal.write(data);
      options.onWritten?.(data.length);
    } catch {
      // Disposed-terminal race — nothing to clean up on the direct path.
    }
    return;
  }

  const entry = getOrCreateEntry(terminal, options);
  // Any non-retained write releases a retained backlog into the normal drain:
  // a foreground write means the pane just became visible (catch-up drains
  // ahead of it, order preserved); a background write without retainWhenHidden
  // means retention was turned off mid-flight.
  entry.retained = false;
  entry.chunks.push({ data, customWrite: options.write !== undefined });
  entry.queuedChars += data.length;

  if (entry.queuedChars > MAX_QUEUE_CHARS) {
    // Bounded memory without data loss: hand everything to xterm now. This
    // is exactly the old always-write behavior, so a flooding hidden pane
    // degrades to the previous baseline instead of losing output.
    flushTerminalOutput(terminal);
    return;
  }

  if (options.foreground) {
    entry.priority = true;
    scheduleDrain(0);
  } else {
    scheduleDrain(
      entry.priority || entry.queuedChars > LARGE_BACKLOG_CHARS
        ? 0
        : BACKGROUND_FLUSH_DELAY_MS,
    );
  }
}

/**
 * Synchronously hand ALL queued bytes for this terminal to xterm (in
 * CHUNK_CHARS slices, order preserved). Used on reveal (hidden → visible
 * catch-up), on queue overflow, and before operations that assume bytes have
 * already reached xterm (reconnect replay / terminal.reset()).
 *
 * "Synchronous" means synchronous HAND-OFF: xterm's own write buffer still
 * parses asynchronously, exactly as it did when useTerminal wrote directly.
 */
export function flushTerminalOutput(terminal: SchedulableTerminal): void {
  // Whatever query was waiting is handed over with the backlog below; a stale
  // pending flag would later parse an unrelated, query-free backlog.
  pendingQueryFlushes.delete(terminal);
  // A forced full hand-off ends any open sync frame: its bytes are about to
  // reach xterm now, so a lingering hold state (and its safety timer) would be
  // stale.
  const hadOpenFrame = syncFrames.has(terminal);
  clearSyncFrame(terminal);
  const entry = queue.get(terminal);
  if (!entry) return;
  entry.heldForSync = false;
  if (hadOpenFrame) {
    // The held bytes carry an unmatched BEGIN; close xterm's sync mode so the
    // handed-over frame paints (twin of the safety-timeout release). Peel a
    // trailing unfinished CSI first so END's ESC cannot abort it.
    closeHeldFrameWithSyntheticEnd(terminal, entry);
  }
  queue.delete(terminal);
  while (hasQueuedChunks(entry)) {
    if (!writeQueuedChunk(entry)) return;
  }
  entry.priority = false;
}

/** Promote a queued terminal's backlog to the PRIORITY drain cadence without a
 *  synchronous full flush. Used on reveal for a backlog that would burst if
 *  parsed in one shot: the budgeted drain (8 writes/tick under an 8ms
 *  wall-clock ceiling) spreads it across frames instead of pinning the renderer
 *  in one giant parse. Byte order is preserved and nothing is dropped.
 *  A retained (hidden, never-parsed) backlog is released here too — the pane
 *  is visible now, and leaving it retained parked the catch-up until the next
 *  PTY write, so a quiet pane kept its stale frame. No-op for a held sync
 *  frame (its close releases it) or an empty queue. */
export function promoteTerminalToPriorityDrain(terminal: SchedulableTerminal): void {
  const entry = queue.get(terminal);
  if (!entry || entry.heldForSync) return;
  if (!hasQueuedChunks(entry)) return;
  entry.retained = false;
  entry.priority = true;
  scheduleDrain(0);
}

/** Drop everything queued for this terminal (teardown path — the terminal is
 *  being disposed, parsing the backlog would be wasted work). */
export function discardTerminalOutput(terminal: SchedulableTerminal): void {
  clearSyncFrame(terminal);
  queue.delete(terminal);
  dirtyTerminals.delete(terminal);
  lastInputAt.delete(terminal);
  escapeCarry.delete(terminal);
  querySplitters.delete(terminal);
  queryParseLog.delete(terminal);
  pendingQueryFlushes.delete(terminal);
}

/** Phase 3: true when this terminal's retained backlog overflowed and was
 *  discarded — its parsed buffer is stale relative to the PTY stream and must
 *  be re-synchronized from the daemon before it is shown or read. */
export function isTerminalDirty(terminal: SchedulableTerminal): boolean {
  return dirtyTerminals.has(terminal);
}

/** True when this terminal currently holds a RETAINED (hidden, never-parsed)
 *  backlog. Retention is only ever set via the retainWhenHidden write path, so
 *  a retained entry tells the caller the queued bytes are daemon-SOURCED (they
 *  arrived over the session pipe and are in the RingBuffer) — a per-pane
 *  provenance signal a non-retained background/local backlog does not carry.
 *
 *  NOTE: this is byte PROVENANCE, not current daemon REACHABILITY — the flag is
 *  historical and stays true if the daemon later disconnects. A caller using
 *  this to justify discarding the backlog must ALSO confirm the daemon is live
 *  now (isDaemonModeActive) so resync can replace what it discards. The
 *  scheduler stays daemon-agnostic on purpose; that check belongs at the
 *  call site. */
export function isTerminalRetained(terminal: SchedulableTerminal): boolean {
  return queue.get(terminal)?.retained === true;
}

/** Phase 3: owner-driven — mark dirty without an overflow (e.g. a daemon
 *  replay arrived while hidden; parsing it would duplicate content already on
 *  screen, so the owner discards and defers to a reveal-time resync). */
export function markTerminalDirty(terminal: SchedulableTerminal): void {
  clearSyncFrame(terminal);
  queue.delete(terminal);
  dirtyTerminals.add(terminal);
  escapeCarry.delete(terminal);
  querySplitters.delete(terminal);
  pendingQueryFlushes.delete(terminal);
}

/** Phase 3: the owner finished re-synchronizing this terminal's screen state
 *  from the daemon — retained writes may accumulate again. */
export function markTerminalClean(terminal: SchedulableTerminal): void {
  dirtyTerminals.delete(terminal);
}

/** Test/debug: chars currently queued for a terminal (0 when absent). */
export function getQueuedCharCount(terminal: SchedulableTerminal): number {
  return queue.get(terminal)?.queuedChars ?? 0;
}

/** Test only: reset all module state. */
export function __resetTerminalOutputSchedulerForTests(): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainDelayMs = null;
  for (const state of syncFrames.values()) {
    if (state.safetyTimer) clearTimeout(state.safetyTimer);
  }
  syncFrames.clear();
  queue.clear();
  dirtyTerminals.clear();
  lastInputAt.clear();
  escapeCarry.clear();
  querySplitters.clear();
  queryParseLog.clear();
  pendingQueryFlushes.clear();
  queryFlushPosted = false;
  retentionEngagedLogged = false;
}
