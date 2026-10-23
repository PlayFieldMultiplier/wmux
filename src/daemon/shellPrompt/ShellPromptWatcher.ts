// Finds a pane with no agent whose foreground command waits on stdin, and
// reports it (informational: nothing is answered from here).
//
// A record needs ALL of these at once; each alone is common and means nothing:
//   a. no agent in the pane (agent panes have their own dialogs and records);
//   b. a command is running: OSC 133 `C` with no `D` since, from a shell that
//      has proven it emits `C`;
//   c. no output for SHELL_PROMPT_QUIET_MS, and not on the alternate screen
//      (vim, less, top draw there);
//   d. the bottom-most non-blank row ends in a prompt shape the daemon knows
//      (shellPromptShape.ts);
//   e. Linux: the foreground process is not blocked on something other than
//      input (foregroundTtyWait.ts). Unknown elsewhere, so it never vetoes there.
// The screen is read only once output has settled, once per settled screen,
// and only when the raw output's last line already looks like a prompt: the
// render (the ring's tail, off the attach and reveal queue) is the rare case.
// A shown prompt clears on any new output, a key, the command's end, or the
// pane going away.
//
// Every set and clear takes the next `seq`, and the list carries the `seq` it
// was taken at: main can then tell a change that arrives after the list but
// happened before it (and drop it) from one that happened after (and keep it).

import { randomUUID } from 'node:crypto';
import type { ShellPromptChange, ShellPromptList, ShellPromptSignal } from '../../shared/shellPrompt';
import { classifyPromptRow, lastNonBlankRow } from './shellPromptShape';
import type { TtyWait } from './foregroundTtyWait';

/** How long output must have stopped before the screen is read. */
export const SHELL_PROMPT_QUIET_MS = 1500;
export const SHELL_PROMPT_TICK_MS = 500;

export interface ShellPromptSignals {
  agentPresent: boolean;
  commandRunning: boolean;
  altScreen: boolean;
  quietMs: number;
  lastRow: string | null;
  ttyWait: TtyWait;
}

/** Gates a–c: the ones known before the screen is read. Pure. */
export function cheapGatesOpen(s: Pick<ShellPromptSignals, 'agentPresent' | 'commandRunning' | 'altScreen' | 'quietMs'>): boolean {
  return !s.agentPresent && s.commandRunning && !s.altScreen && s.quietMs >= SHELL_PROMPT_QUIET_MS;
}

/** The five gates, composed. Pure. */
export function shellPromptFromSignals(s: ShellPromptSignals): ShellPromptSignal | null {
  if (!cheapGatesOpen(s)) return null;
  if (s.ttyWait === 'other') return null;
  return s.lastRow ? classifyPromptRow(s.lastRow) : null;
}

/** The pane at one instant, read synchronously. */
export interface ShellPromptProbe {
  agentPresent: boolean;
  commandRunning: boolean;
  altScreen: boolean;
  /** Output bytes written so far. */
  bytes: number;
  /** Keys and clicks that reached the pane so far (focus reports and pointer motion do not count). */
  keyRevision: number;
  /** The shell's pid, for the Linux wait-channel read. */
  pid?: number;
}

export interface ShellPromptWatcherDeps {
  listSessionIds(): string[];
  /** Null when the pane is gone. */
  probe(sessionId: string): ShellPromptProbe | null;
  /**
   * The last line the newest raw output leaves showing, escapes stripped, or
   * null. Synchronous and cheap: the screen is rendered only when this line
   * could be a prompt, so a dev server or `tail -f` that pauses again and
   * again costs no render.
   */
  tailLine(sessionId: string): string | null;
  /** The visible rows (rebuilt from the ring's tail), or null when they cannot be read. */
  readRows(sessionId: string): Promise<readonly string[] | null>;
  ttyWait(pid: number | undefined): TtyWait;
  /** A prompt appeared or changed (a signal), or cleared (null). Sent on change only. */
  emit(sessionId: string, change: ShellPromptChange): void;
  /** Names this daemon process in every version. Defaults to a random id. */
  epoch?: string;
  now?: () => number;
  tickMs?: number;
  log?: (level: 'warn', message: string) => void;
}

interface PaneWatch {
  bytes: number;
  keyRevision: number;
  changedAt: number;
  /** The output size whose screen was last judged; it is not read again until output moves. */
  judgedBytes?: number;
  reading: boolean;
  shown: ShellPromptSignal | null;
  /** The `seq` that set `shown`. */
  shownSeq: number;
}

const same = (a: ShellPromptSignal | null, b: ShellPromptSignal | null): boolean =>
  a === b || (!!a && !!b && a.shape === b.shape && a.question === b.question);

export class ShellPromptWatcher {
  private readonly panes = new Map<string, PaneWatch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly epoch: string;
  private seq = 0;

  constructor(private readonly deps: ShellPromptWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.epoch = deps.epoch ?? randomUUID();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.tickMs ?? SHELL_PROMPT_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The command ended (OSC 133 `D`): whatever it asked is over. */
  noteCommandEnd(sessionId: string): void {
    this.show(sessionId, null);
  }

  /** A key or click reached the pane: someone is answering at the terminal. */
  noteKey(sessionId: string): void {
    const watch = this.panes.get(sessionId);
    if (!watch) return;
    const probe = this.deps.probe(sessionId);
    if (probe) watch.keyRevision = probe.keyRevision;
    // Not raised again on this same screen: a password typed blind writes no output.
    watch.judgedBytes = watch.bytes;
    this.show(sessionId, null);
  }

  /** Every prompt shown now, as of the latest `seq`: what a client that connects later starts from. */
  list(): ShellPromptList {
    const prompts: ShellPromptList['prompts'] = [];
    for (const [sessionId, watch] of this.panes) if (watch.shown) prompts.push({ sessionId, prompt: watch.shown, seq: watch.shownSeq });
    return { epoch: this.epoch, seq: this.seq, prompts };
  }

  dropSession(sessionId: string): void {
    this.show(sessionId, null);
    this.panes.delete(sessionId);
  }

  /** One pass over every pane. Exposed for tests. */
  async tick(): Promise<void> {
    const live = new Set(this.deps.listSessionIds());
    for (const id of [...this.panes.keys()]) if (!live.has(id)) this.dropSession(id);
    await Promise.all([...live].map((id) => this.check(id)));
  }

  private async check(sessionId: string): Promise<void> {
    const probe = this.deps.probe(sessionId);
    if (!probe) {
      this.dropSession(sessionId);
      return;
    }
    const at = this.now();
    let watch = this.panes.get(sessionId);
    if (!watch) {
      watch = { bytes: probe.bytes, keyRevision: probe.keyRevision, changedAt: at, reading: false, shown: null, shownSeq: 0 };
      this.panes.set(sessionId, watch);
    }
    if (watch.reading) return;
    if (probe.bytes !== watch.bytes) {
      watch.bytes = probe.bytes;
      watch.changedAt = at;
      this.show(sessionId, null);
      return;
    }
    if (probe.keyRevision !== watch.keyRevision) {
      watch.keyRevision = probe.keyRevision;
      watch.judgedBytes = probe.bytes;
      this.show(sessionId, null);
      return;
    }
    // A shown prompt has been quiet for the window already, so a closed gate
    // here is a pane that moved on (an agent, the command's end, the alt screen).
    if (!cheapGatesOpen({ ...probe, quietMs: at - watch.changedAt })) {
      this.show(sessionId, null);
      return;
    }
    if (watch.judgedBytes === probe.bytes) return;
    watch.judgedBytes = probe.bytes;
    // The cheap look first: no render unless the raw last line could be a prompt.
    const line = this.deps.tailLine(sessionId);
    if (!line || !classifyPromptRow(line)) {
      this.show(sessionId, null);
      return;
    }
    watch.reading = true;
    let rows: readonly string[] | null = null;
    try {
      rows = await this.deps.readRows(sessionId);
    } catch (err) {
      this.deps.log?.('warn', `[shellPrompt] screen read failed for ${sessionId}: ${String(err)}`);
    } finally {
      watch.reading = false;
    }
    // Judged on the pane as it is after the read: anything that moved meanwhile waits for the next pass.
    const after = this.deps.probe(sessionId);
    if (!after || after.bytes !== probe.bytes || after.keyRevision !== probe.keyRevision || this.panes.get(sessionId) !== watch) return;
    const prompt = shellPromptFromSignals({
      agentPresent: after.agentPresent,
      commandRunning: after.commandRunning,
      altScreen: after.altScreen,
      quietMs: this.now() - watch.changedAt,
      lastRow: rows ? lastNonBlankRow(rows) : null,
      ttyWait: this.deps.ttyWait(after.pid),
    });
    this.show(sessionId, prompt);
  }

  private show(sessionId: string, prompt: ShellPromptSignal | null): void {
    const watch = this.panes.get(sessionId);
    const before = watch?.shown ?? null;
    if (same(before, prompt)) return;
    if (!watch && prompt) return;
    this.seq += 1;
    if (watch) {
      watch.shown = prompt;
      watch.shownSeq = this.seq;
    }
    this.deps.emit(sessionId, { epoch: this.epoch, seq: this.seq, prompt });
  }
}
