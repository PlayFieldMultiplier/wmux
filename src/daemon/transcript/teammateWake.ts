// The start of a Claude Code lead turn that an Agent Teams teammate's message
// woke up (#2494).
//
// Claude Code fires no `UserPromptSubmit` for such a turn: the lead's hooks
// read `Stop`, then `Stop` again, with nothing in between. A turn that only
// writes text sends no tool hook either, so nothing marked the pane running:
// main's turn latch, still held from the human's prompt, drops the byte
// heuristic, and the pane read finished for the length of the turn.
//
// The transcript records the turn's start. Each woken turn begins with one
// lead `user` entry whose text is `Another Claude session sent a message:`
// followed by `<teammate-message …>` blocks (several messages are batched into
// one entry, and one entry is one turn). Measured on Claude Code 2.1.221-223
// and 2.1.304.
//
// This module reads no file of its own: TranscriptActivityWatcher's tail hands
// it every Claude line it reads, as it does for apiErrorTurnEnd. It decides
// when such an entry is the start of a new turn, and the daemon then opens the
// pane's turn the way a running hook does.
//
// Rules, each from a way this could go wrong:
//   - Only after a turn end. The pane's newest turn boundary must be a Stop /
//     StopFailure hook that fired before the entry was written. An entry
//     written while a turn is open (a message the lead read mid-turn) starts
//     nothing, and neither does one older than the last turn end.
//   - The hook's own time, not its arrival. The next woken turn's entry is
//     written milliseconds after the Stop fires, often before the daemon has
//     ingested that Stop; the entry then waits for it.
//   - After that Stop is applied. A turn end is taken from the Stop the daemon
//     broadcasts, not from the hook's arrival: the completion alarm can hold a
//     Stop for its window (a turn that had working signals, every StopFailure),
//     and a turn opened before the held Stop lands would be closed by it. Even
//     then the broadcast is mid-call (HookIngest records the ended turn after
//     it), so a decision a turn end makes runs once that call has returned.
//   - Once per entry. Entries are keyed by their uuid, so a replay of the
//     window before the watcher's offset, a re-subscribe or a second reader
//     never opens the turn twice. A daemon restart starts with no turn end
//     known, so a replayed entry is older than the first Stop it sees.
//   - Only the lead. A sidechain entry is a subagent's, never the pane's turn.
//   - Only the pane that still reads the file, and only its own binding.

/** What Claude Code writes before the teammate messages of a woken turn. */
const WAKE_PREFIX = 'Another Claude session sent a message:';
const WAKE_TAG = '<teammate-message';
/** Entry uuids remembered per pane; far more than one turn ever replays. */
const SEEN_CAP = 256;

export interface TeammateWake {
  /** The entry's uuid: one entry opens at most one turn. */
  uuid: string;
  /** The entry's own timestamp (ms). */
  at: number;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The text of a user entry's content: a string, or its text blocks. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const first = record(content[0]);
  return first.type === 'text' && typeof first.text === 'string' ? first.text : null;
}

/** The woken-turn start one transcript line records, or null. */
export function teammateWakeFromTranscriptLine(line: string): TeammateWake | null {
  if (!line.includes(WAKE_TAG)) return null;
  let o: Record<string, unknown>;
  try {
    o = record(JSON.parse(line));
  } catch {
    return null;
  }
  if (o.type !== 'user' || o.isSidechain === true) return null;
  const text = contentText(record(o.message).content);
  if (!text || !text.startsWith(WAKE_PREFIX) || !text.includes(WAKE_TAG)) return null;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (typeof o.uuid !== 'string' || !o.uuid || !Number.isFinite(at)) return null;
  return { uuid: o.uuid, at };
}

/** The parts of a broadcast agent event (HookAgentEventData) that tell a turn end. */
export interface TurnEndEvent {
  status: string;
  decision?: string;
  signal: { kind: string; ts: number; payload?: Record<string, unknown> };
}

/**
 * When a broadcast agent event ended the pane's turn, the time its hook fired.
 * A Stop that still projects running (background agents left) ends nothing,
 * and neither does a vetoed or still pending delivery. An interrupted turn's
 * Stop (the Claude Code mod sends it a second or more after the interrupt)
 * ends at the interrupt it stamps.
 */
export function turnEndAt(data: TurnEndEvent): number | undefined {
  if (data.signal.kind !== 'agent.stop' && data.signal.kind !== 'agent.stop_failure') return undefined;
  if (data.status === 'running' || data.decision === 'veto' || data.decision === 'pending') return undefined;
  const endedAt = data.signal.payload?.['wmux_turn_ended_at'];
  if (data.signal.payload?.['wmux_turn_reason'] === 'aborted' && typeof endedAt === 'number' && Number.isFinite(endedAt)) return endedAt;
  return Number.isFinite(data.signal.ts) ? data.signal.ts : undefined;
}

export interface TeammateWakeDeps {
  /** The pane still reads `path` (see ApiErrorTurnEndDeps.isReader). */
  isReader: (sessionId: string, path: string) => boolean;
  /** The pane's own Claude binding names `path`, and no dialog waits on a person. */
  mayOpen: (sessionId: string, path: string) => boolean;
  /** Open the pane's turn; `at` is the entry's own time. */
  emit: (sessionId: string, at: number) => void;
  /** Runs `fn` once the current synchronous call has returned. */
  defer?: (fn: () => void) => void;
}

interface PaneState {
  /** Newest turn-closing hook's fire time, unset until one is seen. */
  endAt?: number;
  /** Newest turn start: a prompt hook, or a woken turn this module opened. */
  startAt?: number;
  /** A wake entry read before the turn end it follows was ingested. */
  pending?: TeammateWake & { path: string };
  seen: Set<string>;
}

export class TeammateWakes {
  private readonly panes = new Map<string, PaneState>();

  private readonly defer: (fn: () => void) => void;

  constructor(private readonly deps: TeammateWakeDeps) {
    this.defer = deps.defer ?? queueMicrotask;
  }

  private pane(sessionId: string): PaneState {
    let p = this.panes.get(sessionId);
    if (!p) {
      p = { seen: new Set() };
      this.panes.set(sessionId, p);
    }
    return p;
  }

  /** One complete line of the pane's Claude transcript, in file order. */
  noteLine(sessionId: string, path: string, line: string): void {
    const wake = teammateWakeFromTranscriptLine(line);
    if (!wake) return;
    const p = this.pane(sessionId);
    if (p.seen.has(wake.uuid)) return;
    p.seen.add(wake.uuid);
    if (p.seen.size > SEEN_CAP) p.seen.delete(p.seen.values().next().value as string);
    p.pending = { ...wake, path };
    this.decide(sessionId, p);
  }

  /** A turn end the daemon applied and broadcast (see turnEndAt); `at` is when its hook fired. */
  noteTurnEnd(sessionId: string, at: number): void {
    const s = this.pane(sessionId);
    // A held StopFailure can land after a later turn's Stop: keep the newest.
    s.endAt = s.endAt === undefined ? at : Math.max(s.endAt, at);
    if (s.pending) this.defer(() => { if (this.panes.get(sessionId) === s) this.decide(sessionId, s); });
  }

  /** Every resolved hook signal for the session; `ts` is when the hook fired. Turn ends come through noteTurnEnd. */
  noteHookSignal(sessionId: string, kind: string, ts?: number): void {
    const p = this.panes.get(sessionId);
    const at = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
    if (kind === 'agent.user_prompt_submit') {
      const s = this.pane(sessionId);
      s.startAt = at;
      // A prompt after the entry starts the turn itself.
      if (s.pending && s.pending.at <= at) s.pending = undefined;
    } else if (kind === 'agent.session_start' && p) {
      // A new session: the old one's turn boundaries say nothing about it.
      p.endAt = undefined;
      p.startAt = undefined;
      p.pending = undefined;
    }
  }

  /** The pane closed or its PTY died. */
  dropSession(sessionId: string): void {
    this.panes.delete(sessionId);
  }

  private decide(sessionId: string, p: PaneState): void {
    const w = p.pending;
    if (!w || p.endAt === undefined) return;
    // The newest boundary is a start: the entry waits for the turn end it follows.
    if (p.startAt !== undefined && p.startAt >= p.endAt) return;
    p.pending = undefined;
    // Written before the last turn end: that turn's own entry, already over.
    if (w.at <= p.endAt) return;
    if (!this.deps.isReader(sessionId, w.path) || !this.deps.mayOpen(sessionId, w.path)) return;
    p.startAt = w.at;
    this.deps.emit(sessionId, w.at);
  }
}
