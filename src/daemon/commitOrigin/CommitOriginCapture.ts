// Records where each commit made in a wmux pane came from
// (shared/commitOrigin.ts). No hook is installed anywhere: git itself appends
// a line to the worktree's `logs/HEAD` for every commit, and this watches that
// file for the worktrees the panes are in (as the git context watcher resolves
// them, locally readable ones only).
//
// When a commit line lands, the panes in that worktree are read AT ONCE (agent,
// its session id, workspace), so a pane that moves to another session later
// does not relink. Then each pane's own output is searched for the short SHA
// for a few seconds (git prints `[branch abc1234] …` after it writes the
// reflog): one pane that shows it is the attribution; otherwise the panes are
// kept as candidates only.

import { createReadStream, watch as fsWatch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseReflogCommit, textShowsSha, type CommitOrigin, type CommitOriginPane, type ReflogCommit } from '../../shared/commitOrigin';
import type { CommitOriginStore } from './CommitOriginStore';

/** When each pane's output is searched for the SHA, after the line lands (ms). */
export const SCREEN_CHECK_DELAYS_MS: readonly number[] = [0, 500, 1500, 4000];
/** Read at most this much of the reflog per change (a rebase can write many lines; the rest is skipped). */
const MAX_READ_BYTES = 64 * 1024;
const DEBOUNCE_MS = 100;
/** A detached HEAD as the git watcher labels it (parseHead): 8 hex digits, not a branch. */
const DETACHED_LABEL_RE = /^[0-9a-f]{8}$/;

export interface CommitOriginCaptureDeps {
  store: Pick<CommitOriginStore, 'add'>;
  /** The pane's rendered text (scrollback and screen), or null. */
  paneText: (ptyId: string) => Promise<string | null>;
  pane: (ptyId: string) => CommitOriginPane;
  /** The open task whose worktree holds the pane's cwd, or null. */
  taskOf: (ptyId: string) => string | null;
  log?: (line: string) => void;
  /** Overridable for tests. */
  watch?: (dir: string, onChange: (filename: string | null) => void) => { close(): void } | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

interface Watched {
  gitDir: string;
  /** Bytes of logs/HEAD already read. */
  offset: number;
  watcher: { close(): void } | null;
  /** Watching the gitDir itself until `logs/` exists (a repo with no commit yet). */
  waitingForLogs: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  reading: Promise<void>;
}

function defaultWatch(dir: string, onChange: (filename: string | null) => void): { close(): void } | null {
  try {
    const w: FSWatcher = fsWatch(dir, { persistent: false }, (_e, f) => onChange(f === null ? null : String(f)));
    w.on('error', () => w.close());
    return w;
  } catch {
    return null;
  }
}

export class CommitOriginCapture {
  /** pane → its worktree's git dir and branch, as the git watcher last said. */
  private readonly panes = new Map<string, { gitDir: string; branch: string | null }>();
  private readonly watched = new Map<string, Watched>();
  private disposed = false;

  constructor(private readonly deps: CommitOriginCaptureDeps) {}

  /** The panes in locally readable worktrees now; watches follow. */
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

  dispose(): void {
    this.disposed = true;
    for (const w of this.watched.values()) this.close(w);
    this.watched.clear();
  }

  private close(w: Watched): void {
    w.watcher?.close();
    w.watcher = null;
    if (w.debounce) clearTimeout(w.debounce);
  }

  private async start(gitDir: string): Promise<void> {
    const w: Watched = { gitDir, offset: 0, watcher: null, waitingForLogs: false, debounce: null, reading: Promise.resolve() };
    this.watched.set(gitDir, w);
    // Only what is appended from now on.
    w.offset = await fs.stat(path.join(gitDir, 'logs', 'HEAD')).then((s) => s.size, () => 0);
    if (this.watched.get(gitDir) !== w) return;
    this.arm(w);
  }

  private arm(w: Watched): void {
    const watch = this.deps.watch ?? defaultWatch;
    const logs = path.join(w.gitDir, 'logs');
    w.watcher = watch(logs, (filename) => {
      if (filename !== null && filename !== 'HEAD') return;
      this.schedule(w);
    });
    w.waitingForLogs = w.watcher === null;
    if (!w.waitingForLogs) return;
    // No logs/ yet: wait for git to create it with the first commit.
    w.watcher = watch(w.gitDir, (filename) => {
      if (filename !== null && filename !== 'logs') return;
      if (!w.waitingForLogs || this.watched.get(w.gitDir) !== w) return;
      w.watcher?.close();
      w.watcher = null;
      this.arm(w);
      if (!w.waitingForLogs) this.schedule(w);
    });
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
    if (this.watched.get(w.gitDir) !== w) return;
    const file = path.join(w.gitDir, 'logs', 'HEAD');
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    if (size < w.offset) w.offset = size; // rewritten (reflog expire): start over from its end
    if (size === w.offset) return;
    if (size - w.offset > MAX_READ_BYTES) {
      // Far more than any commit writes: skip to the end.
      w.offset = size;
      return;
    }
    const chunk = await new Promise<string>((resolve, reject) => {
      let text = '';
      createReadStream(file, { start: w.offset, end: size - 1, encoding: 'utf8' })
        .on('data', (d) => { text += d; })
        .on('end', () => resolve(text))
        .on('error', reject);
    });
    // Only whole lines; a partial last line is read again with the next change.
    const last = chunk.lastIndexOf('\n');
    if (last < 0) return;
    w.offset += Buffer.byteLength(chunk.slice(0, last + 1));
    for (const line of chunk.slice(0, last).split('\n')) {
      const commit = parseReflogCommit(line);
      if (commit) this.onCommit(w.gitDir, commit);
    }
  }

  /** A commit landed in `gitDir`: read its panes now, then look for evidence. */
  onCommit(gitDir: string, commit: ReflogCommit): void {
    const ids = [...this.panes].filter(([, p]) => p.gitDir === gitDir).map(([id]) => id);
    if (ids.length === 0) return;
    const label = this.panes.get(ids[0])?.branch ?? null;
    const branch = label && !DETACHED_LABEL_RE.test(label) ? label : null;
    const panes = ids.map((id) => ({ pane: this.deps.pane(id), taskId: this.deps.taskOf(id) }));
    void this.findEvidence(commit, branch, panes);
  }

  private async findEvidence(commit: ReflogCommit, branch: string | null, panes: Array<{ pane: CommitOriginPane; taskId: string | null }>): Promise<void> {
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
    let waited = 0;
    for (const delay of SCREEN_CHECK_DELAYS_MS) {
      if (delay > waited) {
        await new Promise<void>((resolve) => { setTimer(resolve, delay - waited); });
        waited = delay;
      }
      if (this.disposed) return;
      const shown = [];
      for (const p of panes) {
        const text = await this.deps.paneText(p.pane.ptyId).catch(() => null);
        if (text && textShowsSha(text, commit.sha)) shown.push(p);
      }
      if (shown.length === 1) {
        this.deps.store.add({ ...commit, branch, evidence: 'screen', attributed: { ...shown[0].pane, taskId: shown[0].taskId } });
        return;
      }
      // Two panes showing it (one ran `git log`) is not evidence of which made it.
      if (shown.length > 1) break;
    }
    const origin: CommitOrigin = {
      ...commit,
      branch,
      evidence: panes.length === 1 ? 'only-pane' : 'none',
      candidates: panes.map((p) => p.pane),
    };
    this.deps.store.add(origin);
  }
}
