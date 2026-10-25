// StallWatch — says when a Claude turn in a terminal pane seems stuck.
//
// A running Claude repaints its spinner about every 100 ms for the whole turn,
// so terminal bytes never go quiet and cannot tell a stall from work. What can:
// the agent's own transcript, which it appends to as a turn makes progress, and
// the token counter on its spinner row. Rules, each from a way this goes wrong:
//
//   - Claude only. Codex has not been measured, and any other agent has no
//     transcript reader. No binding, no transcript, no mid-turn: no alert.
//   - Silence is measured on the transcript itself (size and mtime, stat-polled
//     here: TranscriptActivityWatcher stops for hook-fed sessions).
//   - A tool in flight is never a stall: a `tool_use` with no `tool_result`
//     since the last prompt (a subagent's `Agent` call stays open until the
//     subagent returns), or a tool_started hook after the last append. Build
//     and test runs are the common long quiet. A tail that cannot show the
//     whole turn counts as unknown.
//   - Extended thinking writes nothing for minutes (246 s measured at 33k
//     tokens), and the spinner row shows no token count, or only an earlier
//     one, while it thinks. So the short threshold applies only while a visible
//     token count, outside a thinking phase, stays frozen for the whole window;
//     anything else falls back to the long transcript-only threshold.
//   - The agent must still say it is running: its spinner row or its running
//     title. A turn the daemon still holds open with neither is not reported.
//   - Waiting on the human (a dialog, an approval) is not silence.
//   - Keep waiting doubles the threshold for that turn only; a new prompt or a
//     new turn resets it. Never stops anything on its own.
import fs from 'node:fs';
import type { ResumeBinding } from '../../shared/agentResume';
import type { AgentSlug } from '../../shared/agentIdentity';
import type { ChatInterruptResult } from '../../shared/transcript/turnEvents';
import type { StallPrefillResult } from '../../shared/types';
import { formatBracketedPastePayload } from '../../shared/ptyMessageDelivery';
import { screenShowsRunningTurn } from './chatScreenGate';
import { claudeComposerEmpty, claudeComposerVisible, type ChatScreenRows } from './deliverChatPrompt';
import { contentBlocks, isObject, PENDING_TOOL_USE_TAIL_BYTES } from './pendingToolUse';

/** The one agent whose turns are watched: the rules below read Claude's own
 *  spinner row, composer and transcript. Codex waits until it is measured. */
export const STALL_AGENT = 'claude' satisfies AgentSlug;

/** Silence with a frozen, visible token count. */
export const STALL_COUNTER_MS = 180_000;
/** Silence when the token count cannot be read for the whole window. */
export const STALL_FALLBACK_MS = 600_000;
export const STALL_TICK_MS = 10_000;

export interface StallWatchDeps {
  listSessionIds: () => string[];
  getBinding: (id: string) => ResumeBinding | undefined;
  /** The running turn's id while the daemon has the agent mid-turn, else null. */
  midTurn: (id: string) => string | null;
  /** A dialog or an approval waits on the human. */
  awaitingHuman: (id: string) => boolean;
  readScreen: (id: string) => Promise<readonly string[] | null>;
  /** The agent's window title shows its running spinner, freshly set. */
  titleRunning?: (id: string) => boolean;
  emit: (id: string, stalledSince: number | null) => void;
  stat?: (path: string) => { size: number; mtimeMs: number } | null;
  /** True/false; null when the tail cannot tell. */
  toolInFlight?: (path: string) => boolean | null;
  now?: () => number;
}

interface Watch {
  turn: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** Last append, counter move, tool start or human wait: the silence clock's start. */
  progressAt: number;
  /** Last token count seen on the spinner row. */
  counter?: string;
  /** Start of the current run of samples that all showed a count. */
  readableFrom?: number;
  toolStartedAt: number;
  stalledSince?: number;
}

/** Claude's thinking phrases on the spinner row ("still thinking", "deep in
 *  thought", "thought for 1s"). Measured: after a tool, the row kept
 *  `↓ 262 tokens · deep in thought` unchanged for 170 s of healthy thinking. */
const THINKING_PHASE = /\bthinking\b|\bthought\b/i;

/**
 * The token count on Claude's spinner row (`↓ 1.2k tokens`), or undefined when
 * there is no row, no count, or the row says it is thinking: thinking tokens
 * are not counted, so a count shown then is an earlier one standing still.
 */
export function spinnerTokenCount(rows: readonly string[] | null): string | undefined {
  if (!rows) return undefined;
  // The last match: the live row is drawn under any earlier output that looks like one.
  const row = [...rows].reverse().find((line) => screenShowsRunningTurn([line], STALL_AGENT));
  if (!row || THINKING_PHASE.test(row)) return undefined;
  return /([\d.,]+k?) tokens\b/.exec(row)?.[1];
}

type Entry = Record<string, unknown>;

/** Claude's own wrappers for a turn it started from a command, a hook or a notice. */
const NOT_A_TYPED_PROMPT = /<(?:command-name|command-message|command-args|local-command-stdout|task-notification|bash-input|bash-stdout)>/;
const INTERRUPT_MARK = /^\[Request interrupted by user/;

/** A user row with text (not a tool result, not meta, not a subagent's): its text, else null. */
function userText(entry: Entry): string | null {
  if (entry['type'] !== 'user' || entry['isMeta'] === true || entry['isSidechain'] === true) return null;
  const message = entry['message'];
  if (isObject(message) && typeof message['content'] === 'string') return message['content'];
  const blocks = contentBlocks(entry);
  if (!blocks.length || blocks.some((b) => b['type'] === 'tool_result')) return null;
  return blocks.map((b) => (typeof b['text'] === 'string' ? b['text'] : '')).join('\n');
}

/**
 * A prompt the human typed. A notice Claude writes as a user row mid-turn (a
 * background task finishing, a local command's output) is not one: it starts
 * no new turn, so the calls still open stay open.
 */
function isHumanTurnStart(entry: Entry): boolean {
  const text = userText(entry);
  return text !== null && !NOT_A_TYPED_PROMPT.test(text);
}

/**
 * Whether a tool call since the last prompt has no result yet. A prompt starts
 * a new count, so an orphaned call of an earlier turn never holds a later one.
 * Sidechain entries are another agent's. Null when the window was cut and
 * holds no prompt: an open call may lie before it.
 */
export function transcriptToolInFlight(entries: readonly unknown[], opts: { windowCut?: boolean } = {}): boolean | null {
  const open = new Set<string>();
  let sawPrompt = false;
  for (const entry of entries) {
    if (!isObject(entry) || entry['isSidechain'] === true) continue;
    if (isHumanTurnStart(entry)) { open.clear(); sawPrompt = true; continue; }
    for (const block of contentBlocks(entry)) {
      if (entry['type'] === 'assistant' && block['type'] === 'tool_use' && typeof block['id'] === 'string') open.add(block['id']);
      if (entry['type'] === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') open.delete(block['tool_use_id']);
    }
  }
  if (open.size > 0) return true;
  return opts.windowCut && !sawPrompt ? null : false;
}

/**
 * The prompt the current turn started from, exactly as written, or null when
 * it cannot be put back as typed: a slash command, a notice, an image, or no
 * prompt in the window. Never an earlier turn's prompt: the walk stops at the
 * latest user row with text, notices included.
 */
export function lastHumanPrompt(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isObject(entry)) continue;
    const text = userText(entry);
    if (text === null) continue;
    if (contentBlocks(entry).some((b) => b['type'] !== 'text')) return null;
    // Claude's own row after an interrupt is not the prompt; the one before it may be.
    if (INTERRUPT_MARK.test(text.trim())) continue;
    return text.trim() && !NOT_A_TYPED_PROMPT.test(text) ? text : null;
  }
  return null;
}

/** The transcript's tail, parsed; `windowCut` when it starts mid-file. Null when unreadable. */
export function readTranscriptTail(path: string): { entries: unknown[]; windowCut: boolean } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - PENDING_TOOL_USE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const entries: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* a half-written last line */ }
    }
    return { entries, windowCut: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

function readToolInFlight(path: string): boolean | null {
  const tail = readTranscriptTail(path);
  return tail ? transcriptToolInFlight(tail.entries, { windowCut: tail.windowCut }) : null;
}

function statFile(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

export class StallWatch {
  private readonly watches = new Map<string, Watch>();
  /** Keep waiting's factor per pane, kept with its turn so a one-tick gap does not reset it. */
  private readonly factors = new Map<string, { turn: string; factor: number }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: StallWatchDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined); }, STALL_TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watches.clear();
    this.factors.clear();
  }

  /** The pane's stall (its last progress) when it reads as stuck now, for a client that attaches later. */
  stalledSince(id: string): number | null {
    return this.watches.get(id)?.stalledSince ?? null;
  }

  /** A resolved hook signal for the pane. */
  noteHookSignal(id: string, kind: string): void {
    if (kind === 'agent.user_prompt_submit') this.factors.delete(id);
    const w = this.watches.get(id);
    if (!w) return;
    if (kind === 'agent.tool_started' || kind === 'agent.awaiting_permission' || kind === 'agent.user_prompt_submit') {
      const now = this.now();
      if (kind !== 'agent.user_prompt_submit') w.toolStartedAt = now;
      w.progressAt = now;
      this.clear(id, w);
    }
  }

  /** Keep waiting: double the threshold for this turn. False when not stalled. */
  keepWaiting(id: string): boolean {
    const w = this.watches.get(id);
    if (!w || w.stalledSince === undefined) return false;
    const saved = this.factors.get(id);
    this.factors.set(id, { turn: w.turn, factor: (saved?.turn === w.turn ? saved.factor : 1) * 2 });
    this.clear(id, w);
    return true;
  }

  /** The pane closed. */
  dropSession(id: string): void {
    this.forget(id);
    this.factors.delete(id);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const ids = new Set(this.deps.listSessionIds());
      for (const id of [...this.watches.keys()]) if (!ids.has(id)) this.dropSession(id);
      for (const id of ids) {
        // One pane's failure must not stop the others, nor reach the process.
        try { await this.check(id); } catch { this.forget(id); }
      }
    } finally {
      this.ticking = false;
    }
  }

  private forget(id: string): void {
    const w = this.watches.get(id);
    if (w) this.clear(id, w);
    this.watches.delete(id);
  }

  private clear(id: string, w: Watch): void {
    if (w.stalledSince === undefined) return;
    w.stalledSince = undefined;
    this.deps.emit(id, null);
  }

  private factorFor(id: string, turn: string): number {
    const saved = this.factors.get(id);
    return saved?.turn === turn ? saved.factor : 1;
  }

  private async check(id: string): Promise<void> {
    const binding = this.deps.getBinding(id);
    const turn = this.deps.midTurn(id);
    const path = binding?.agent === STALL_AGENT ? binding.transcriptPath : undefined;
    const st = path && turn ? (this.deps.stat ?? statFile)(path) : null;
    if (!path || !turn || !st) { this.forget(id); return; }
    const now = this.now();
    let w = this.watches.get(id);
    if (!w || w.turn !== turn || w.path !== path) {
      if (w) this.clear(id, w);
      w = { turn, path, size: st.size, mtimeMs: st.mtimeMs, progressAt: now, toolStartedAt: 0 };
      this.watches.set(id, w);
    } else if (st.size !== w.size || st.mtimeMs !== w.mtimeMs) {
      w.size = st.size;
      w.mtimeMs = st.mtimeMs;
      w.progressAt = now;
      this.clear(id, w);
    }
    if (this.deps.awaitingHuman(id)) {
      w.progressAt = now;
      this.clear(id, w);
      return;
    }
    let rows: readonly string[] | null = null;
    try { rows = await this.deps.readScreen(id); } catch { /* unreadable: no count */ }
    // The pane may have moved on while the screen was read.
    if (this.watches.get(id) !== w) return;
    const count = spinnerTokenCount(rows);
    if (count === undefined) {
      w.readableFrom = undefined;
    } else {
      if (w.counter !== undefined && count !== w.counter) {
        w.progressAt = now;
        this.clear(id, w);
      }
      w.counter = count;
      w.readableFrom ??= now;
    }
    // A count visible across the whole silence (one tick of sampling slack).
    const counted = w.readableFrom !== undefined && w.readableFrom <= w.progressAt + STALL_TICK_MS;
    const threshold = (counted ? STALL_COUNTER_MS : STALL_FALLBACK_MS) * this.factorFor(id, turn);
    const running = screenShowsRunningTurn(rows, STALL_AGENT) || this.deps.titleRunning?.(id) === true;
    if (now - w.progressAt < threshold || w.toolStartedAt >= w.progressAt || !running) {
      this.clear(id, w);
      return;
    }
    if (w.stalledSince !== undefined) return;
    // Read the tail only once the silence is long enough to matter.
    if ((this.deps.toolInFlight ?? readToolInFlight)(path) !== false) return;
    // Stuck since the last progress, which is what "for N min" counts from.
    w.stalledSince = w.progressAt;
    this.deps.emit(id, w.progressAt);
  }
}

export interface StallPrefillDeps {
  /** A dialog or an approval waits on the human: an ESC would answer it, so nothing is sent. */
  blocked: () => boolean;
  interrupt: () => Promise<ChatInterruptResult>;
  /** The prompt to put back, read before the interrupt. */
  lastPrompt: () => string | null;
  /** The pane's turn identity: a turn started after the interrupt never gets the stopped turn's prompt. */
  turnId?: () => string | undefined;
  readScreen: () => Promise<ChatScreenRows | null>;
  write: (data: string) => boolean;
  /** Take the pane's keyboard from the chat send queue for the paste; null when it is taken. */
  holdKeyboard?: () => (() => void) | null;
  delay?: (ms: number) => Promise<void>;
}

/** Composer reads, 250 ms apart, that must all be empty before a paste. */
const EMPTY_READS = 6;
const PREFILL_READS = 24;

/**
 * Stop the turn, then put the last prompt back into Claude's input without
 * sending it. Claude restores the prompt by itself when the interrupt comes
 * before anything was written, so the paste happens only into a composer that
 * stays empty for 1.5 s, and is read once more right before the write; one
 * holding anything is left as it is. The chat send queue is held off the
 * keyboard meanwhile, so its Enter cannot send the pasted prompt.
 */
export async function stopAndPrefill(deps: StallPrefillDeps): Promise<StallPrefillResult> {
  if (deps.blocked()) return 'blocked';
  const prompt = deps.lastPrompt()?.trim() || null;
  const stoppedTurn = deps.turnId?.();
  // interruptChatTurn checks again right before its ESC (open approval,
  // awaiting_input, a dialog on the screen read).
  const stopped = await deps.interrupt();
  if (stopped !== 'sent') return stopped === 'session_changed' ? 'unavailable' : stopped;
  if (!prompt) return 'stopped';
  const release = deps.holdKeyboard ? deps.holdKeyboard() : () => undefined;
  if (!release) return 'stopped';
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = async (): Promise<ChatScreenRows | null> => {
    try { return await deps.readScreen(); } catch { return null; }
  };
  try {
    let empty = 0;
    for (let i = 0; i < PREFILL_READS; i++) {
      await delay(250);
      const rows = await read();
      if (!rows || screenShowsRunningTurn(rows, STALL_AGENT)) { empty = 0; continue; }
      if (claudeComposerEmpty(rows)) {
        if (++empty < EMPTY_READS) continue;
        if (!claudeComposerEmpty(await read())) return 'kept';
        if (deps.turnId && deps.turnId() !== stoppedTurn) return 'kept';
        return deps.write(formatBracketedPastePayload(prompt)) ? 'filled' : 'error';
      }
      empty = 0;
      if (claudeComposerVisible(rows)) return 'kept';
    }
    // The ESC went out, but the turn never showed an input to fill.
    return 'blocked';
  } finally {
    release();
  }
}
