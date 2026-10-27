// Records where each commit made in a wmux pane came from
// (shared/commitOrigin.ts). No hook is installed anywhere: git itself appends
// a line to the worktree's `logs/HEAD` for every commit, and this watches that
// file for the worktrees the panes are in (those the git context watcher
// watches with fs.watch). Like that watcher in the daemon, it reads nothing on
// this thread: every read goes through the reader process, and fs.watch is
// armed only on a directory that reader has just opened.
//
// When a commit line lands, every live pane is read AT ONCE (agent, its
// session id, workspace, task), so a pane that moves to another session later
// does not relink. Then each pane's output is searched for git's summary line
// for that commit (`[branch abc1234] …`) for a few seconds: one pane showing it,
// over the whole window, is the attribution. Otherwise the panes in that
// worktree are kept as candidates only.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Probe, ProbeAnswer } from '../../main/pty/gitContextWatch';
import {
  COMMIT_ORIGIN_MAX_CANDIDATES,
  parseReflogCommit,
  textShowsCommitSummary,
  type CommitOrigin,
  type CommitOriginPane,
  type ReflogCommit,
} from '../../shared/commitOrigin';
import type { CommitOriginStore } from './CommitOriginStore';

/** When the panes' output is searched for the summary line, after the line lands (ms). */
export const SCREEN_CHECK_DELAYS_MS: readonly number[] = [0, 500, 1500, 4000];
/** The reader's `tail` answers at most this much (shareReader.ts). */
const TAIL_MAX_BYTES = 64 * 1024;
const DEBOUNCE_MS = 100;
/** A watch that failed is armed again after this long (ms). */
const REARM_MS = 1000;
/** SHAs already handled, so a reflog read again after a rewrite records nothing twice. */
const HANDLED_MAX = 512;
/** A detached HEAD as the git watcher labels it (parseHead): 8 hex digits, not a branch. */
const DETACHED_LABEL_RE = /^[0-9a-f]{8}$/;

export interface CommitOriginCaptureDeps {
  store: Pick<CommitOriginStore, 'add'>;
  /** A read through the reader process (GitContextWatcher.readThroughReader). */
  read: (probe: Probe) => Promise<ProbeAnswer>;
  /** Every live pane. */
  livePanes: () => string[];
  /** The pane's rendered text (scrollback and screen), or null. */
  paneText: (ptyId: string) => Promise<string | null>;
  pane: (ptyId: string) => CommitOriginPane;
  /** The open task whose worktree holds the pane's cwd, or null. */
  taskOf: (ptyId: string) => string | null;
  log?: (line: string) => void;
  /** Overridable for tests. */
  watch?: (dir: string, onChange: (filename: string | null) => void, onError: () => void) => { close(): void } | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
}

interface Watched {
  gitDir: string;
  /** Bytes of logs/HEAD already read, and the file they were read from. */
  offset: number;
  ino: number;
  /** When this watch began: a reflog re-read after a rewrite records only lines from then on. */
  since: number;
  watcher: { close(): void } | null;
  debounce: ReturnType<typeof setTimeout> | null;
  reading: Promise<void>;
  closed: boolean;
}

interface Tail { size: number; ino: number; bytes: Buffer }

function defaultWatch(dir: string, onChange: (filename: string | null) => void, onError: () => void): { close(): void } | null {
  try {
    const w: FSWatcher = fsWatch(dir, { persistent: false }, (_e, f) => onChange(f === null ? null : String(f)));
    w.on('error', () => {
      w.close();
      onError();
    });
    return w;
  } catch {
    return null;
  }
}

function parseTail(answer: ProbeAnswer): Tail | null {
  if (typeof answer !== 'string' || !answer.startsWith('{')) return null;
  try {
    const t = JSON.parse(answer) as { size?: unknown; ino?: unknown; bytes?: unknown };
    if (typeof t.size !== 'number' || typeof t.ino !== 'number' || typeof t.bytes !== 'string') return null;
    return { size: t.size, ino: t.ino, bytes: Buffer.from(t.bytes, 'base64') };
  } catch {
    return null;
  }
}

export class CommitOriginCapture {
  /** pane → its worktree's git dir and branch, as the git watcher last said. */
  private readonly panes = new Map<string, { gitDir: string; branch: string | null }>();
  private readonly watched = new Map<string, Watched>();
  private readonly handled = new Set<string>();
  /** Commits still gathering evidence: settled with what is known on dispose. */
  private readonly pending = new Set<() => void>();
  private disposed = false;

  constructor(private readonly deps: CommitOriginCaptureDeps) {}

  /** The panes in watched worktrees now; watches follow. */
  sync(panes: ReadonlyArray<{ sessionId: string; gitDir: string; branch: string | null }>): void {
    if (this.disposed) return;
    this.panes.clear();
    for (const p of panes) this.panes.set(p.sessionId, { gitDir: p.gitDir, branch: p.branch });
    const wanted = new Set(panes.map((p) => p.gitDir));
    for (const [gitDir, w] of this.watched) {
      if (!wanted.has(gitDir)) {
        this.close(w);
        this.watched.delete(gitDir);
      }
    }
    for (const gitDir of wanted) if (!this.watched.has(gitDir)) void this.start(gitDir);
  }

  /** Stops watching; a commit still gathering evidence is recorded with its candidates. */
  dispose(): void {
    for (const settle of [...this.pending]) settle();
    this.disposed = true;
    for (const w of this.watched.values()) this.close(w);
    this.watched.clear();
  }

  private close(w: Watched): void {
    w.closed = true;
    w.watcher?.close();
    w.watcher = null;
    if (w.debounce) clearTimeout(w.debounce);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async tail(w: Watched, from: number): Promise<Tail | null> {
    try {
      return parseTail(await this.deps.read({ op: 'tail', path: path.join(w.gitDir, 'logs', 'HEAD'), from }));
    } catch {
      return null; // missed the reader's deadline: the next change reads again
    }
  }

  private async start(gitDir: string): Promise<void> {
    const w: Watched = { gitDir, offset: 0, ino: 0, since: this.now(), watcher: null, debounce: null, reading: Promise.resolve(), closed: false };
    this.watched.set(gitDir, w);
    // Only what is appended from now on.
    const t = await this.tail(w, Number.MAX_SAFE_INTEGER);
    if (w.closed) return;
    if (t) {
      w.offset = t.size;
      w.ino = t.ino;
    }
    await this.arm(w);
  }

  /** Watch logs/ for HEAD, or, with no logs/ yet (no commit yet), the git dir
   *  for it to appear: each only once the reader has opened it. */
  private async arm(w: Watched): Promise<void> {
    const watch = this.deps.watch ?? defaultWatch;
    const logs = path.join(w.gitDir, 'logs');
    const opened = async (dir: string) => (await this.deps.read({ op: 'open', path: dir }).catch(() => null)) === 'opened';
    const onError = () => {
      if (w.closed) return;
      w.watcher = null;
      this.rearmLater(w);
    };
    if (await opened(logs)) {
      if (w.closed) return;
      w.watcher = watch(logs, (filename) => {
        if (filename !== null && filename !== 'HEAD') return;
        this.schedule(w);
      }, onError);
      if (w.watcher) {
        this.schedule(w); // a line appended before the watch went live
        return;
      }
    }
    if (w.closed || !(await opened(w.gitDir)) || w.closed) {
      if (!w.closed) this.rearmLater(w);
      return;
    }
    w.watcher = watch(w.gitDir, (filename) => {
      if (filename !== null && filename !== 'logs') return;
      if (w.closed) return;
      w.watcher?.close();
      w.watcher = null;
      void this.arm(w);
    }, onError);
    if (!w.watcher) this.rearmLater(w);
  }

  private rearmLater(w: Watched): void {
    const t = setTimeout(() => {
      if (!w.closed && !w.watcher) void this.arm(w);
    }, REARM_MS);
    t.unref?.();
  }

  private schedule(w: Watched): void {
    if (w.debounce) clearTimeout(w.debounce);
    w.debounce = setTimeout(() => {
      w.debounce = null;
      w.reading = w.reading.then(() => this.readNew(w)).catch((err) => this.deps.log?.(`[commitOrigin] reflog read failed: ${String(err)}`));
    }, DEBOUNCE_MS);
    w.debounce.unref?.();
  }

  private async readNew(w: Watched): Promise<void> {
    if (w.closed) return;
    const t = await this.tail(w, w.offset);
    if (w.closed) return;
    if (!t) {
      // Gone (a removed logs/): read it whole when it is back.
      w.offset = 0;
      w.ino = 0;
      return;
    }
    const rewritten = (w.ino !== 0 && t.ino !== w.ino) || t.size < w.offset;
    if (rewritten || t.size - w.offset > TAIL_MAX_BYTES) {
      // Rewritten (`reflog expire`), or far more than any commit writes: read
      // the end of it again and keep only lines from since this watch began.
      const end = await this.tail(w, Math.max(0, t.size - TAIL_MAX_BYTES));
      if (w.closed || !end) return;
      w.offset = end.size;
      w.ino = end.ino;
      this.lines(w, end.bytes, end.size > end.bytes.length, true);
      return;
    }
    w.ino = t.ino;
    // Whole lines only, counted in bytes; a partial last line is read again
    // with the next change.
    const last = t.bytes.lastIndexOf(0x0a);
    if (last < 0) return;
    w.offset += last + 1;
    this.lines(w, t.bytes.subarray(0, last + 1), false, false);
  }

  private lines(w: Watched, bytes: Buffer, skipFirst: boolean, onlySinceStart: boolean): void {
    const lines = bytes.toString('utf8').split('\n');
    if (skipFirst) lines.shift(); // begins mid-line
    for (const line of lines) {
      const commit = parseReflogCommit(line);
      if (!commit) continue;
      // Reflog times are whole seconds.
      if (onlySinceStart && commit.at < w.since - 1000) continue;
      this.onCommit(w.gitDir, commit);
    }
  }

  /** A commit landed in `gitDir`: read the panes now, then look for evidence. */
  onCommit(gitDir: string, commit: ReflogCommit): void {
    if (this.disposed || this.handled.has(commit.sha)) return;
    this.handled.add(commit.sha);
    if (this.handled.size > HANDLED_MAX) this.handled.delete(this.handled.values().next().value as string);
    const inWorktree = [...this.panes].filter(([, p]) => p.gitDir === gitDir).map(([id]) => id);
    if (inWorktree.length === 0) return;
    const label = this.panes.get(inWorktree[0])?.branch ?? null;
    const branch = label && !DETACHED_LABEL_RE.test(label) ? label : null;
    // Every live pane: the one that ran `git commit` may sit in another
    // directory (`cd ../wt && git commit`).
    const ids = [...new Set([...inWorktree, ...this.deps.livePanes()])];
    const panes = new Map(ids.map((id) => [id, { pane: this.deps.pane(id), taskId: this.deps.taskOf(id) }]));
    const candidates = inWorktree.slice(0, COMMIT_ORIGIN_MAX_CANDIDATES).map((id) => panes.get(id)?.pane as CommitOriginPane);
    void this.findEvidence(commit, branch, panes, candidates);
  }

  private async findEvidence(
    commit: ReflogCommit,
    branch: string | null,
    panes: Map<string, { pane: CommitOriginPane; taskId: string | null }>,
    candidates: CommitOriginPane[],
  ): Promise<void> {
    const shown = new Set<string>();
    let settled = false;
    // Attributed only when one pane, and no other, showed it over the whole
    // window; cut short (dispose) or ambiguous, the worktree's panes are candidates.
    const settle = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      this.pending.delete(onDispose);
      const only = complete && shown.size === 1 ? panes.get([...shown][0]) : undefined;
      const origin: CommitOrigin = only
        ? { ...commit, branch, evidence: 'screen', attributed: { ...only.pane, taskId: only.taskId } }
        : { ...commit, branch, evidence: candidates.length === 1 ? 'only-pane' : 'none', candidates };
      this.deps.store.add(origin);
    };
    const onDispose = () => settle(false);
    this.pending.add(onDispose);
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
    let waited = 0;
    for (const delay of SCREEN_CHECK_DELAYS_MS) {
      if (delay > waited) {
        await new Promise<void>((resolve) => { setTimer(resolve, delay - waited); });
        waited = delay;
      }
      if (settled) return;
      for (const id of panes.keys()) {
        if (shown.has(id)) continue;
        const text = await this.deps.paneText(id).catch(() => null);
        if (text && textShowsCommitSummary(text, commit.sha)) shown.add(id);
      }
      if (settled) return;
      // Two panes showing it is no evidence of which made it.
      if (shown.size > 1) break;
    }
    settle(true);
  }
}
