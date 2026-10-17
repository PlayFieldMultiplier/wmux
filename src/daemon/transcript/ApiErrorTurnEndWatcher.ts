// ApiErrorTurnEndWatcher — the turn end of a Claude Code turn that died on an
// API error, for installs that never registered the `StopFailure` hook.
//
// Claude Code fires `StopFailure` INSTEAD of `Stop` when a turn ends on an API
// error, and only when a StopFailure hook is registered. Installs made before
// that hook existed (and every account dir provisioned from one: the account's
// settings.json is a one-time copy) register `UserPromptSubmit` but not
// `StopFailure`, so the prompt hook opened the turn and nothing ever closed it:
// the pane read `running` forever after e.g. "organization has disabled Claude
// subscription access". The transcript records that turn end anyway, as an
// assistant entry with `isApiErrorMessage: true` and the same `error` code the
// hook would carry. This tails it and, when no hook closed the turn, feeds the
// daemon the same `agent.stop_failure` signal the hook would have sent.
//
// Rules, each from a way this could go wrong:
//   - The hook wins. A StopFailure or Stop hook arriving for the turn within
//     GRACE_MS of the entry means the install has the hook: nothing is sent.
//   - Only a turn end. A later assistant or user entry before the grace runs
//     out means the turn went on, so the entry was not its end.
//   - Only an open turn. A pane whose daemon turn is already closed gets
//     nothing: there is no stuck state to clear and no toast is owed.
//   - Appended bytes only. A watch starts at the file's end (no history
//     replay) and reads at most READ_CAP_BYTES per tick; a replaced or
//     truncated file re-seats at its end.

import fs from 'node:fs';
import type { AgentSignal } from '../../shared/hooks/signal-types';
import { statTranscript } from './readTail';

/** Most bytes read for one session in one tick. */
export const READ_CAP_BYTES = 256 * 1024;
/** How long the real hook gets to arrive before the transcript speaks. */
export const GRACE_MS = 3000;
const DEFAULT_POLL_MS = 1500;
/** Same bound the phone failure card clips Claude's text to. */
const MAX_MESSAGE_CHARS = 2000;

export interface ApiErrorTurnEnd {
  /** Claude Code's error code (`rate_limit`, `oauth_org_not_allowed`, …). */
  error: string;
  /** The text Claude showed for it. */
  message: string;
}

/**
 * The API-error turn end one transcript line records, or null. `error` is kept
 * only when it is code-shaped: the usage-limit registry and the phone failure
 * classifier switch on it, and `unknown` is what Claude Code itself reports
 * when it has none.
 */
export function apiErrorFromTranscriptLine(line: string): ApiErrorTurnEnd | null {
  if (!line.includes('"isApiErrorMessage":true')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  // A subagent's failure is not the pane's turn end.
  if (o.type !== 'assistant' || o.isApiErrorMessage !== true || o.isSidechain === true) return null;
  const error = typeof o.error === 'string' && /^[a-z0-9_]{1,64}$/.test(o.error) ? o.error : 'unknown';
  const content = (o.message && typeof o.message === 'object' ? (o.message as Record<string, unknown>).content : undefined);
  let message = '';
  if (typeof content === 'string') message = content;
  else if (Array.isArray(content)) {
    message = content
      .map((block) => (block && typeof block === 'object' && typeof (block as Record<string, unknown>).text === 'string'
        ? (block as Record<string, unknown>).text as string
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return { error, message: message.trim().slice(0, MAX_MESSAGE_CHARS) };
}

/** A conversation entry that is not an API error: the turn is still going. */
function isTurnProgress(line: string): boolean {
  return /"type":"(assistant|user)"/.test(line) && !line.includes('"isApiErrorMessage":true');
}

export interface ApiErrorTurnEndDeps {
  listSessionIds: () => string[];
  /** The pane's transcript binding, when it names one. */
  getBinding: (id: string) => { agent: string; sessionId: string; cwd: string; transcriptPath?: string } | undefined;
  /** The daemon's turn bookkeeping: an episode is open on the pane. */
  isTurnOpen: (id: string) => boolean;
  /** Feed the synthesized signal into the hook ingest. */
  emit: (signal: AgentSignal) => void;
  now?: () => number;
  pollMs?: number;
}

interface Watch {
  path: string;
  ino: number;
  offset: number;
  pending?: { end: ApiErrorTurnEnd; seenAt: number; agentSessionId: string; cwd: string };
}

export class ApiErrorTurnEndWatcher {
  private readonly watches = new Map<string, Watch>();
  /** Newest turn-closing hook (Stop / StopFailure) and turn-start hook per pane. */
  private readonly turnEndHookAt = new Map<string, number>();
  private readonly promptHookAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ApiErrorTurnEndDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watches.clear();
    this.turnEndHookAt.clear();
    this.promptHookAt.clear();
  }

  /** Every resolved hook signal for the session. */
  noteHookSignal(sessionId: string, kind: string): void {
    if (kind === 'agent.stop' || kind === 'agent.stop_failure') this.turnEndHookAt.set(sessionId, this.now());
    else if (kind === 'agent.user_prompt_submit') this.promptHookAt.set(sessionId, this.now());
  }

  /** The pane closed or its PTY died. */
  dropSession(sessionId: string): void {
    this.watches.delete(sessionId);
    this.turnEndHookAt.delete(sessionId);
    this.promptHookAt.delete(sessionId);
  }

  tick(): void {
    const live = new Set(this.deps.listSessionIds());
    for (const id of [...this.watches.keys(), ...this.turnEndHookAt.keys(), ...this.promptHookAt.keys()]) {
      if (!live.has(id)) this.dropSession(id);
    }
    for (const id of live) {
      try {
        this.step(id);
      } catch {
        // One unreadable transcript must never stop the others.
        this.watches.delete(id);
      }
    }
  }

  private step(id: string): void {
    const binding = this.deps.getBinding(id);
    const path = binding?.agent === 'claude' ? binding.transcriptPath : undefined;
    if (!binding || !path) {
      this.watches.delete(id);
      return;
    }
    const stat = statTranscript(path);
    if (!stat) {
      this.watches.delete(id);
      return;
    }
    const watch = this.watches.get(id);
    if (!watch || watch.path !== path || watch.ino !== stat.ino || stat.size < watch.offset) {
      // New, replaced or truncated: start at the end, report nothing.
      this.watches.set(id, { path, ino: stat.ino, offset: stat.size });
      return;
    }
    if (stat.size > watch.offset) this.read(watch, stat.size, binding.sessionId, binding.cwd);
    this.settle(id, watch);
  }

  private read(watch: Watch, size: number, agentSessionId: string, cwd: string): void {
    const length = Math.min(size - watch.offset, READ_CAP_BYTES);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(watch.path, 'r');
    let got = 0;
    try {
      got = fs.readSync(fd, buf, 0, length, watch.offset);
    } finally {
      fs.closeSync(fd);
    }
    const text = buf.subarray(0, got).toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) {
      // One line longer than the cap is never an error entry: skip past it.
      if (got === READ_CAP_BYTES) watch.offset += got;
      return;
    }
    watch.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const end = apiErrorFromTranscriptLine(line);
      if (end) watch.pending = { end, seenAt: this.now(), agentSessionId, cwd };
      else if (watch.pending && isTurnProgress(line)) watch.pending = undefined;
    }
  }

  private settle(id: string, watch: Watch): void {
    const pending = watch.pending;
    if (!pending || this.now() - pending.seenAt < GRACE_MS) return;
    watch.pending = undefined;
    // A turn-end hook around the entry, newer than the turn's prompt, is the
    // installed hook speaking for this very turn.
    const hookEnd = this.turnEndHookAt.get(id);
    if (hookEnd !== undefined && hookEnd >= pending.seenAt - GRACE_MS && hookEnd > (this.promptHookAt.get(id) ?? 0)) return;
    if (!this.deps.isTurnOpen(id)) return;
    this.deps.emit({
      kind: 'agent.stop_failure',
      agent: 'claude',
      agentSessionId: pending.agentSessionId,
      cwd: pending.cwd,
      ptyId: id,
      ts: this.now(),
      payload: { error: pending.end.error, last_assistant_message: pending.end.message },
    });
  }
}
