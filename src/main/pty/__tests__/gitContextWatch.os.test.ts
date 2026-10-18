import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitContextWatcher,
  parseHead,
  resolveRepo,
  resolveRepoState,
  readGitContext,
  type GitWatchFactory,
  type GitWatchListener,
} from '../gitContextWatch';
import { watchTarget } from '../../../shared/watchTarget';
import { shortPathOf } from '../../../test-utils/shortPath';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitwatch-'));
}

function initFakeRepo(root: string, branch = 'main'): void {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

const tmpDirs: string[] = [];
const watchers: GitContextWatcher[] = [];

function tmp(): string {
  const dir = mkTmpDir();
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lock */ }
  }
});

/** One armed watch recorded by the fake factory. */
interface ArmedWatch {
  target: string;
  listener: GitWatchListener;
  closed: boolean;
}

/**
 * Fake `fs.watch` so the watcher's own logic (filename filter, debounce,
 * re-resolve, teardown) is asserted without waiting on real FSEvents/inotify
 * delivery — which is what made these tests flaky on loaded CI runners.
 */
function fakeWatchFactory(): { arms: ArmedWatch[]; factory: GitWatchFactory; last(): ArmedWatch } {
  const arms: ArmedWatch[] = [];
  const factory: GitWatchFactory = (target, listener) => {
    const rec: ArmedWatch = { target, listener, closed: false };
    arms.push(rec);
    return {
      close() { rec.closed = true; },
      on() { return this; },
    };
  };
  return { arms, factory, last: () => arms[arms.length - 1] };
}

describe('parseHead', () => {
  it('parses a branch ref', () => {
    expect(parseHead('ref: refs/heads/main\n')).toBe('main');
  });

  it('parses a branch ref with slashes', () => {
    expect(parseHead('ref: refs/heads/feat/x1-sidebar\n')).toBe('feat/x1-sidebar');
  });

  it('returns the short SHA for a detached HEAD', () => {
    expect(parseHead('0123456789abcdef0123456789abcdef01234567\n')).toBe('01234567');
  });

  it('returns null for garbage', () => {
    expect(parseHead('')).toBeNull();
    expect(parseHead('not a head')).toBeNull();
  });
});

describe('resolveRepo', () => {
  it('resolves a .git directory at the cwd', () => {
    const root = tmp();
    initFakeRepo(root);
    const repo = resolveRepo(root);
    expect(repo).not.toBeNull();
    expect(repo!.isWorktree).toBe(false);
    expect(repo!.gitDir).toBe(path.join(root, '.git'));
  });

  it('walks up from a nested cwd', () => {
    const root = tmp();
    initFakeRepo(root, 'dev');
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    const repo = resolveRepo(nested);
    expect(repo?.gitDir).toBe(path.join(root, '.git'));
    expect(readGitContext(repo!)).toEqual({ branch: 'dev', isWorktree: false });
  });

  it('resolves a linked-worktree .git file with gitdir indirection', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature-x\n');

    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    const repo = resolveRepo(wt);
    expect(repo).not.toBeNull();
    expect(repo!.isWorktree).toBe(true);
    expect(readGitContext(repo!)).toEqual({ branch: 'feature-x', isWorktree: true });
  });

  // #2407: a worktree added by Linux git on a Windows drive records its gitdir
  // as the WSL path of the host folder.
  it.runIf(process.platform === 'win32')('resolves a gitdir written as a WSL drive-mount path', () => {
    const main = tmp();
    initFakeRepo(main);
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt2');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature-wsl\n');
    // `C:\Users\me\x` → `/mnt/c/Users/me/x`
    const asWsl = '/mnt/' + wtGitDir[0].toLowerCase() + wtGitDir.slice(2).replace(/\\/g, '/');

    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${asWsl}\n`);

    const repo = resolveRepo(wt);
    expect(repo?.gitDir.toLowerCase()).toBe(wtGitDir.toLowerCase());
    expect(readGitContext(repo!)).toEqual({ branch: 'feature-wsl', isWorktree: true });
  });

  it('returns null outside any repository', () => {
    // os.tmpdir() itself could theoretically sit in a repo on a dev box; a
    // fresh nested dir without .git anywhere within MAX_WALK_UP of the drive
    // root is still the realistic non-repo case.
    const root = tmp();
    const repo = resolveRepo(path.join(root));
    // The tmp dir's ancestors shouldn't contain .git; tolerate either null
    // or a repo ABOVE tmp (CI sandbox edge) by asserting it's not inside root.
    if (repo) {
      expect(repo.gitDir.startsWith(root)).toBe(false);
    } else {
      expect(repo).toBeNull();
    }
  });
});

describe('GitContextWatcher', () => {
  /** The watcher's internal REREAD_DEBOUNCE_MS. */
  const DEBOUNCE_MS = 50;

  let fake: ReturnType<typeof fakeWatchFactory>;
  let events: Array<{ sessionId: string; branch: string | null; isWorktree: boolean; absent?: true }>;

  /** Build a watcher wired to the fake factory, with events collected. */
  function makeWatcher(): GitContextWatcher {
    const w = new GitContextWatcher(fake.factory);
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    return w;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fake = fakeWatchFactory();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the initial branch on update()', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
  });

  it('arms the watch on the git dir before the first read', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    makeWatcher().update('s1', root);
    expect(fake.arms).toHaveLength(1);
    expect(fake.last().target).toBe(watchTarget(path.join(root, '.git')));
  });

  it.runIf(process.platform === 'win32')('arms on the long spelling when the cwd is an 8.3 short path (#984)', (ctx) => {
    // libuv 1.52 garbles (or asserts on) the event filename for a directory
    // watched through a short alias, and the HEAD filter would drop it.
    const root = tmp();
    initFakeRepo(root, 'main');
    const short = shortPathOf(root);
    if (!short) return ctx.skip(); // 8.3 names are off for this volume
    makeWatcher().update('s1', short);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
    expect(fake.last().target).not.toContain('~');
    expect(fake.last().target.toLowerCase()).toBe(
      fs.realpathSync.native(path.join(root, '.git')).toLowerCase(),
    );
  });

  it('emits again when HEAD changes (branch switch)', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events).toHaveLength(1);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    fake.last().listener('change', 'HEAD');
    // Nothing before the debounce elapses…
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(events).toHaveLength(1);
    // …and exactly one re-emit after it.
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('feature-y');
  });

  it('coalesces a burst of HEAD events into a single re-emit', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feature-y\n');
    for (let i = 0; i < 5; i++) {
      fake.last().listener('change', 'HEAD');
      vi.advanceTimersByTime(10); // each event restarts the debounce
    }
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('feature-y');
  });

  it('reacts to HEAD.lock (the rename git uses) and ignores unrelated files', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/locked\n');
    for (const name of ['config', 'index', 'refs', 'ORIG_HEAD', 'HEADER']) {
      fake.last().listener('change', name);
    }
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(events).toHaveLength(1); // filtered out — no re-read scheduled

    fake.last().listener('rename', 'HEAD.lock');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBe('locked');
  });

  it('does not re-emit an unchanged value when HEAD is rewritten identically', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fake.last().listener('change', 'HEAD');
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(events).toHaveLength(1);
  });

  it('does not re-emit an unchanged value on a repeated update()', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    watcher.update('s1', root);
    watcher.update('s1', path.join(root)); // identical cwd
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(events).toHaveLength(1);
  });

  it('emits branch null when leaving a repo for a non-repo cwd', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const plain = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    watcher.update('s1', plain);
    expect(events).toHaveLength(2);
    expect(events[1].branch).toBeNull();
    expect(events[1].isWorktree).toBe(false);
    expect(events[1].absent).toBe(true);
  });

  it('repo → non-repo → repo: known absent only while outside a repo', () => {
    const a = tmp();
    initFakeRepo(a, 'main');
    const plain = tmp();
    const b = tmp();
    initFakeRepo(b, 'feat');
    const watcher = makeWatcher();
    watcher.update('s1', a);
    watcher.update('s1', plain);
    watcher.update('s1', b);
    expect(events).toEqual([
      { sessionId: 's1', branch: 'main', isWorktree: false },
      { sessionId: 's1', branch: null, isWorktree: false, absent: true },
      { sessionId: 's1', branch: 'feat', isWorktree: false },
    ]);
  });

  it('an unreadable HEAD inside a repo is unknown, not absent', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git')); // no HEAD file
    makeWatcher().update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('outside a repo with no live watch, "no branch" is unknown', () => {
    const w = new GitContextWatcher(() => { throw new Error('EPERM'); });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', tmp());
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a non-repo watch that errors turns known absent back into unknown', () => {
    let onError: (() => void) | undefined;
    const w = new GitContextWatcher(() => ({
      close() { /* nothing armed */ },
      on(_event: 'error', listener: () => void) { onError = listener; return this; },
    }));
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', tmp());
    expect(events.at(-1)?.absent).toBe(true);
    onError?.();
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ sessionId: 's1', branch: null, isWorktree: false });
  });

  it('resync() re-emits every session\'s current answer, unchanged or not', () => {
    const repo = tmp();
    initFakeRepo(repo, 'main');
    const plain = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', repo);
    watcher.update('s2', plain);
    expect(events).toHaveLength(2);
    watcher.resync();
    expect(events.slice(2)).toEqual([
      { sessionId: 's1', branch: 'main', isWorktree: false },
      { sessionId: 's2', branch: null, isWorktree: false, absent: true },
    ]);
  });

  it('a walk that gives up before the root is unknown, not absent', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    // 30 levels below the repo: past the 24-level walk limit.
    const deep = path.join(root, ...Array.from({ length: 30 }, (_, i) => `d${i}`));
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveRepoState(deep)).toEqual({ repo: null, conclusive: false });
    makeWatcher().update('s1', deep);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a cwd reached through a symlink into a repo is not absent', () => {
    const repo = tmp();
    initFakeRepo(repo, 'main');
    const src = path.join(repo, 'src');
    fs.mkdirSync(src);
    const alias = path.join(tmp(), 'alias');
    try {
      fs.symlinkSync(src, alias, 'junction');
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    const state = resolveRepoState(alias);
    expect(state.repo?.gitDir).toBe(path.join(fs.realpathSync.native(repo), '.git'));
    makeWatcher().update('s1', alias);
    expect(events).toEqual([{ sessionId: 's1', branch: 'main', isWorktree: false }]);
  });

  it('a bare repository (no .git, HEAD at the top) is unknown, not absent', () => {
    const bare = tmp();
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(bare, 'objects'));
    fs.mkdirSync(path.join(bare, 'refs'));
    const sub = path.join(bare, 'objects');
    expect(resolveRepoState(bare).conclusive).toBe(false);
    expect(resolveRepoState(sub).conclusive).toBe(false);
    makeWatcher().update('s1', bare);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a bare clone into a watched non-repo cwd drops the known absent', () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(events.at(-1)?.absent).toBe(true);
    fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
    fake.last().listener('rename', 'HEAD');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: null, isWorktree: false });
  });

  it('a .git created while the cwd watch is being armed is not missed as absent', () => {
    const root = tmp();
    const w = new GitContextWatcher((target, listener) => {
      initFakeRepo(root, 'raced'); // appears before the watch is live
      return fake.factory(target, listener);
    });
    watchers.push(w);
    w.on('git', (e) => events.push(e));
    w.update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('a non-repo cwd that cannot be resolved to a real path is unknown', () => {
    const gone = path.join(tmp(), 'gone');
    expect(resolveRepoState(gone)).toEqual({ repo: null, conclusive: false });
  });

  it('a .git file without a gitdir line is unknown, not absent', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.git'), 'garbage\n');
    makeWatcher().update('s1', root);
    expect(events).toEqual([{ sessionId: 's1', branch: null, isWorktree: false }]);
  });

  it('resync() resolves a non-repo session again (an ancestor git init)', () => {
    const parent = tmp();
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(sub);
    const watcher = makeWatcher();
    watcher.update('s1', sub);
    expect(events.at(-1)?.absent).toBe(true);
    initFakeRepo(parent, 'late');
    watcher.resync();
    expect(events.at(-1)).toEqual({ sessionId: 's1', branch: 'late', isWorktree: false });
    expect(events).toHaveLength(2);
  });

  it('picks up a git init in a previously non-repo cwd without polling', () => {
    const root = tmp();
    const watcher = makeWatcher();
    watcher.update('s1', root);
    // Outside a repo the watch arms on the cwd itself.
    expect(fake.last().target).toBe(watchTarget(root));
    const nonRepoWatch = fake.last();

    // Unrelated files in the cwd must not trigger a re-resolve.
    nonRepoWatch.listener('rename', 'scratch.txt');
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(fake.arms).toHaveLength(1);

    initFakeRepo(root, 'fresh');
    nonRepoWatch.listener('rename', '.git');
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(events.at(-1)?.branch).toBe('fresh');
    // Re-armed on the freshly resolved git dir; the old watch was closed.
    expect(nonRepoWatch.closed).toBe(true);
    expect(fake.last().target).toBe(watchTarget(path.join(root, '.git')));
  });

  it('remove() closes the watch and clears a pending debounce', () => {
    const root = tmp();
    initFakeRepo(root, 'main');
    const watcher = makeWatcher();
    watcher.update('s1', root);
    expect(watcher.size).toBe(1);

    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/never-seen\n');
    fake.last().listener('change', 'HEAD');
    watcher.remove('s1');

    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(watcher.size).toBe(0);
    expect(fake.last().closed).toBe(true);
    expect(events).toHaveLength(1); // the pending re-read never fired
  });

  it('dispose() closes every session watch and clears pending debounces', () => {
    const a = tmp();
    const b = tmp();
    initFakeRepo(a, 'main');
    initFakeRepo(b, 'dev');
    const watcher = makeWatcher();
    watcher.update('s1', a);
    watcher.update('s2', b);
    expect(events).toHaveLength(2);

    for (const arm of fake.arms) arm.listener('change', 'HEAD');
    watcher.dispose();
    vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    expect(watcher.size).toBe(0);
    expect(fake.arms.every((a2) => a2.closed)).toBe(true);
    expect(events).toHaveLength(2);
  });
});
