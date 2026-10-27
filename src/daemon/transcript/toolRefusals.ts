// The last refused tool call of each pane's Claude, from its transcript
// (shared/toolRefusal.ts): fed every line the transcript activity watcher
// reads (TranscriptActivityWatcher.onClaudeLine), in file order.
//
// A refusal stands until the agent moves past it: a later tool call that ran,
// or the person's next prompt. It outlives the turn's end, so a turn that
// stopped on it can say so. Another transcript (a new session in the pane)
// starts afresh, and so does a pane that is gone.

import { toolOutcomeOfLine, type ToolRefusal } from '../../shared/toolRefusal';

/** The first Claude Code version measured to write the decision fields (2.1.311; added in 2.1.307). */
const DECISION_FIELDS_SINCE: readonly number[] = [2, 1, 307];

function atLeast(version: string, min: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const n = Number(parts[i + 1]);
    if (n !== min[i]) return n > min[i];
  }
  return true;
}

export interface ToolRefusalTrackerDeps {
  /** The pane's last refusal changed (null: cleared). */
  emit: (sessionId: string, refusal: ToolRefusal | null) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export class ToolRefusalTracker {
  private readonly current = new Map<string, { path: string; refusal: ToolRefusal | null }>();
  private warned = false;

  constructor(private readonly deps: ToolRefusalTrackerDeps) {}

  noteLine(sessionId: string, path: string, line: string): void {
    let state = this.current.get(sessionId);
    if (state && state.path !== path) {
      // Another transcript: what the last one refused is not this session's.
      this.set(sessionId, null);
      state = undefined;
    }
    if (!state) {
      state = { path, refusal: null };
      this.current.set(sessionId, state);
    }
    const outcome = toolOutcomeOfLine(line, (this.deps.now ?? Date.now)());
    if (!outcome) return;
    if (outcome.type === 'unknown') {
      // A version that writes the fields wrote a result without them: the
      // format moved on. Nothing is read from it; say so once.
      if (!this.warned && outcome.version && atLeast(outcome.version, DECISION_FIELDS_SINCE)) {
        this.warned = true;
        this.deps.log?.(`[toolRefusal] Claude Code ${outcome.version} wrote a tool result without its permission decision; refusals are not read from it`);
      }
      return;
    }
    this.set(sessionId, outcome.type === 'refused' ? outcome.refusal : null);
  }

  get(sessionId: string): ToolRefusal | null {
    return this.current.get(sessionId)?.refusal ?? null;
  }

  /** The pane is gone. */
  drop(sessionId: string): void {
    this.set(sessionId, null);
    this.current.delete(sessionId);
  }

  /** Every pane's refusal again (an app that just subscribed has none). */
  resync(): void {
    for (const [sessionId, state] of this.current) if (state.refusal) this.deps.emit(sessionId, state.refusal);
  }

  private set(sessionId: string, refusal: ToolRefusal | null): void {
    const state = this.current.get(sessionId);
    const before = state?.refusal ?? null;
    if (state) state.refusal = refusal;
    if (before === refusal || (before && refusal && before.toolUseId === refusal.toolUseId && before.kind === refusal.kind)) return;
    this.deps.emit(sessionId, refusal);
  }
}
