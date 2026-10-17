// task.push / task.fetch run git on the repository main recorded, and every
// network call in a clean git dir main makes for it (real git where it can
// run here; the WSL shape by its argv and env).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, pushTaskBranch, type TaskPushExec, type TaskPushGit } from '../taskPush';
import { fetchTaskRefs } from '../taskFetch';
import {
  cleanGitConfigArgs, cleanGitEnv, cleanGitSeedPackedRefs, guardedRefPathRefusal, parseRawGitConfigList, parseSeedTips, transportConfigDiff,
  type PathKind, type RefPathPorts,
} from '../../../shared/taskGitCleanDir';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

const FILE_OK = { protocols: ['https', 'ssh', 'file'] };

describe('clean git dir: argv, env and config diff', () => {
  it('forces no gc, no maintenance, no commit-graph or multi-pack index, and https and ssh only', () => {
    expect(cleanGitConfigArgs(['-c', 'core.fsmonitor=false'])).toEqual([
      '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    ]);
  });

  it('names the clean dir and the recorded objects, adds the owner\'s config by count, and never sets GIT_CONFIG_NOSYSTEM', () => {
    expect(cleanGitEnv('/c', '/r/.git/objects', [['core.sshCommand', 'ssh -i k']])).toEqual({
      GIT_DIR: '/c', GIT_OBJECT_DIRECTORY: '/r/.git/objects', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'ssh -i k',
    });
    expect(cleanGitEnv('/c', '/o')).toEqual({ GIT_DIR: '/c', GIT_OBJECT_DIRECTORY: '/o' });
  });

  it('carries over only the owner\'s transport keys an include adds for the repository, in order, case kept', () => {
    const list = (rows: Array<[string, string, string]>) => rows.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join('');
    const clean = parseRawGitConfigList(list([
      ['system', 'credential.helper', 'osxkeychain'],
      ['global', 'user.name', 'me'],
    ]));
    const context = parseRawGitConfigList(list([
      ['system', 'credential.helper', 'osxkeychain'],
      ['global', 'user.name', 'me'],
      // From `includeIf "gitdir:~/work/"` in the owner's global config.
      ['global', 'credential.helper', ''],
      ['global', 'credential.helper', 'store --file ~/.work-creds'],
      ['global', 'url.git@work.example:Team/.insteadOf', 'https://work.example/Team/'],
      ['global', 'core.sshcommand', 'ssh -i ~/.ssh/work'],
      ['global', 'user.email', 'me@work.example'],
      // The repository's own config never carries over.
      ['local', 'core.sshcommand', 'ssh -o x'],
      ['local', 'url.https://elsewhere.example/.pushinsteadof', 'https://work.example/'],
    ]));
    expect(transportConfigDiff(context, clean)).toEqual([
      ['credential.helper', ''],
      ['credential.helper', 'store --file ~/.work-creds'],
      ['url.git@work.example:Team/.insteadOf', 'https://work.example/Team/'],
      ['core.sshcommand', 'ssh -i ~/.ssh/work'],
    ]);
    expect(transportConfigDiff(clean, clean)).toEqual([]);
  });

  it('seeds at most 32 commits as refs/seed/<n>', () => {
    const tips = parseSeedTips(`${'a'.repeat(40)} commit\n${'b'.repeat(40)} tag\n${'c'.repeat(40)} commit\n${'a'.repeat(40)} commit\nzz commit\n`);
    expect(tips).toEqual(['a'.repeat(40), 'c'.repeat(40)]);
    expect(cleanGitSeedPackedRefs(tips)).toBe(`${'a'.repeat(40)} refs/seed/0\n${'c'.repeat(40)} refs/seed/1\n`);
    expect(cleanGitSeedPackedRefs(Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(40, '0'))).split('\n').filter(Boolean)).toHaveLength(32);
  });

  it('the ref path check: a link, a file in a folder\'s place, a folder at the ref, a packed-refs link, a moved repository', async () => {
    const ports = (kinds: Record<string, PathKind>, real: Record<string, string> = {}, caseInsensitive = false): RefPathPorts => ({
      join: (...p) => path.posix.join(...p),
      kinds: async (ps) => ps.map((p) => kinds[p] ?? 'missing'),
      realpath: async (p) => real[p] ?? p,
      caseInsensitive,
    });
    const ref = 'refs/remotes/origin/feat/x';
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/refs': 'dir', '/r/refs/remotes': 'dir' }))).toBeNull();
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/refs': 'dir', '/r/refs/remotes': 'symlink' }))).toMatch(/refs\/remotes is a link/);
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/refs': 'dir', '/r/refs/remotes': 'dir', '/r/refs/remotes/origin': 'dir', '/r/refs/remotes/origin/feat': 'file' }))).toMatch(/is not a folder/);
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/refs': 'dir', '/r/refs/remotes': 'dir', '/r/refs/remotes/origin': 'dir', '/r/refs/remotes/origin/feat': 'dir', '/r/refs/remotes/origin/feat/x': 'dir' }))).toMatch(/not a plain file/);
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/logs': 'symlink' }))).toMatch(/logs is a link/);
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/packed-refs': 'symlink' }))).toMatch(/packed-refs/);
    expect(await guardedRefPathRefusal('/r', ref, ports({}, { '/r': '/elsewhere' }))).toMatch(/no longer resolves/);
    // A junction Node does not report as a link still resolves elsewhere.
    expect(await guardedRefPathRefusal('/r', ref, ports({ '/r/refs': 'dir' }, { '/r/refs': '/x/refs' }))).toMatch(/does not resolve to itself/);
    expect(await guardedRefPathRefusal('C:/R', ref, ports({}, { 'C:/R': 'c:/r' }, true))).toBeNull();
    expect(await guardedRefPathRefusal('/r', 'refs/heads/main', ports({}))).toMatch(/not a remote-tracking ref/);
    expect(await guardedRefPathRefusal('/r', 'refs/remotes/origin/../../heads/main', ports({}))).toMatch(/not a remote-tracking ref/);
  });
});

describe('clean git dir: inside WSL', () => {
  it('runs the network call in the distro with the clean dir\'s drvfs path, the recorded objects through WSLENV, and no GIT_CONFIG_NOSYSTEM', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-clean-wsl-')));
    const cleanRoot = path.join(root, 'clean');
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const sha = 'a'.repeat(40);
    const exec: TaskPushExec = async (_file, args, env) => {
      calls.push({ args, env });
      const prog = args[5];
      if (prog === 'realpath') return { code: 0, stdout: `${args[args.length - 1]}\n`, stderr: '' };
      if (prog === 'stat') return { code: 1, stdout: '', stderr: 'stat: cannot statx: No such file or directory' };
      if (args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@github.com/acme/app.git\0', stderr: '' };
      if (args.includes('--is-shallow-repository')) return { code: 0, stdout: 'false\n', stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${sha}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await pushTaskBranch(
        { worktreePath: 'C:\\Users\\me\\.wmux\\worktrees\\h\\t', branch: 'wtask/one', defaultBranches: [], noHooksDir: 'C:\\Users\\me\\.wmux\\factory\\no-hooks', gitCommonDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git', cleanRoot },
        async () => ({ code: 1, stdout: '', stderr: 'host git' }),
        {
          platform: 'win32',
          readDotGit: () => 'gitdir: //wsl.localhost/Ubuntu/home/me/repo/.git/worktrees/t\n',
          wslExec: exec,
          toWslPath: (p) => `/mnt/c/wmux${p.slice(root.length)}`,
        },
      );
      expect(r).toMatchObject({ ok: true, head: sha });
      const push = calls.find((c) => c.args.includes('push'));
      expect(push).toBeDefined();
      const { args, env } = push as { args: string[]; env: NodeJS.ProcessEnv };
      expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/', '--exec', 'git']);
      expect(args[6]).toMatch(/^--git-dir=\/mnt\/c\/wmux\/clean\/c-/);
      expect(args).toEqual(expect.arrayContaining(['protocol.allow=never', 'gc.auto=0', 'core.hooksPath=/dev/null']));
      expect(env.GIT_OBJECT_DIRECTORY).toBe('/home/me/repo/.git/objects');
      expect(env.GIT_DIR).toBe(args[6].slice('--git-dir='.length));
      const names = (env.WSLENV ?? '').split(':');
      for (const n of ['GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_TERMINAL_PROMPT']) expect(names).toContain(n);
      expect(names.some((n) => n.startsWith('GIT_') && n.includes('/'))).toBe(false);
      expect(calls.some((c) => 'GIT_CONFIG_NOSYSTEM' in c.env)).toBe(false);
      // The recorded repository by its Linux path; the worktree's gitdir for HEAD only.
      const local = calls.filter((c) => c.args[6] === '--git-dir=/home/me/repo/.git');
      expect(local.some((c) => c.args.includes('update-ref') && c.args.includes('--no-deref') && c.args.includes('core.logAllRefUpdates=false'))).toBe(true);
      expect(calls.filter((c) => c.args[6] === '--git-dir=/home/me/repo/.git/worktrees/t').map((c) => c.args.slice(11))).toEqual([['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']]);
      // The ref path is checked inside the distro, argv only.
      expect(calls.some((c) => c.args[5] === 'stat' && c.args.includes('/home/me/repo/.git/refs/remotes/origin/wtask/one'))).toBe(true);
      expect(fs.readdirSync(cleanRoot)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('clean git dir: real git', () => {
  let root: string;
  let origin: string;
  let repo: string;
  let wt: string;
  let common: string;
  let third: string;
  let otherOrigin: string;
  let marker: string;
  let prog: string;
  const gitconfig = () => path.join(os.homedir(), '.gitconfig');
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-clean-git-')));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    wt = path.join(root, 'wt');
    third = path.join(root, 'third');
    otherOrigin = path.join(root, 'other-origin.git');
    marker = path.join(root, 'program-ran');
    prog = path.join(root, 'prog.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', otherOrigin]);
    for (const [dir, remote] of [[repo, origin], [third, otherOrigin]]) {
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      fs.writeFileSync(path.join(dir, 'a.txt'), `${dir}\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'init');
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', 'origin', 'main');
    }
    git(repo, 'worktree', 'add', '-q', '-b', 'wtask/one', wt);
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'work');
    git(third, 'worktree', 'add', '-q', '-b', 'wtask/one', path.join(root, 'other-wt'));
    common = fs.realpathSync.native(path.join(repo, '.git'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(gitconfig(), { force: true });
  });

  const input = (over: Record<string, unknown> = {}) => ({ worktreePath: wt, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh'), gitCommonDir: common, cleanRoot: path.join(root, 'clean'), ...over });
  /** main's git, with `then` run once right after the repository config check. */
  const afterPreflight = (then: () => void, seen: Array<{ args: string[]; env?: Record<string, string> }> = []): TaskPushGit => {
    let done = false;
    return async (args, cwd, env) => {
      seen.push({ args, env });
      const r = await defaultGit(args, cwd, env);
      if (!done && args.includes('--list') && args.includes(`--git-dir=${common}`)) {
        done = true;
        then();
      }
      return r;
    };
  };
  const refsOf = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');
  const otherState = () => ({ refs: refsOf(third), config: fs.readFileSync(path.join(third, '.git', 'config'), 'utf8'), origin: refsOf(otherOrigin) });

  it('a worktree .git file swapped during the call: nothing reaches another repository or origin', async () => {
    const before = otherState();
    const hook = afterPreflight(() => fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(third, '.git', 'worktrees', 'other-wt')}\n`));
    const r = await pushTaskBranch(input(), hook, FILE_OK);
    expect(r.ok).toBe(false);
    expect(otherState()).toEqual(before);
    expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).toBe('refs/remotes/origin/main');
  });

  it('a worktree commondir swapped during the call: nothing reaches another repository or origin', async () => {
    const before = otherState();
    const commondir = path.join(common, 'worktrees', 'wt', 'commondir');
    const hook = afterPreflight(() => fs.writeFileSync(commondir, `${path.join(third, '.git')}\n`));
    const pushed = await pushTaskBranch(input(), hook, FILE_OK);
    expect(pushed.ok).toBe(false);
    expect(otherState()).toEqual(before);
    expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    // The fetch writes only into the recorded repository, whatever commondir says.
    const fetched = await fetchTaskRefs(input(), afterPreflight(() => undefined), FILE_OK);
    expect(fetched).toMatchObject({ ok: true });
    expect(otherState()).toEqual(before);
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(origin, 'rev-parse', 'main'));
  });

  it('a URL rewrite and an ssh command written into the repository config during the call have no effect on the push or the fetch', async () => {
    const plant = () => {
      git(repo, 'config', `url.${otherOrigin}.pushInsteadOf`, origin);
      git(repo, 'config', `url.${otherOrigin}.insteadOf`, origin);
      git(repo, 'config', 'core.sshCommand', prog);
    };
    const unplant = () => {
      for (const k of [`url.${otherOrigin}.pushInsteadOf`, `url.${otherOrigin}.insteadOf`, 'core.sshCommand']) git(repo, 'config', '--unset-all', k);
    };
    const pushed = await pushTaskBranch(input(), afterPreflight(plant), FILE_OK);
    expect(pushed).toMatchObject({ ok: true, head: git(wt, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(git(otherOrigin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    unplant();
    const fetched = await fetchTaskRefs(input(), afterPreflight(plant), FILE_OK);
    expect(fetched).toMatchObject({ ok: true, fetched: [{ ref: 'origin/main', sha: git(origin, 'rev-parse', 'main') }, { ref: 'origin/wtask/one', sha: git(origin, 'rev-parse', 'wtask/one') }] });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('an ssh command written during the call is never run, for an ssh origin (push and fetch)', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
    const plant = () => git(repo, 'config', 'core.sshCommand', prog);
    expect((await pushTaskBranch(input(), afterPreflight(plant))).ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    git(repo, 'config', '--unset-all', 'core.sshCommand');
    expect((await fetchTaskRefs(input(), afterPreflight(plant))).ok).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('every clean dir is a fresh one under main\'s folder; one already there, with its own config, is never used', async () => {
    git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
    const planted = path.join(root, 'clean', 'c-planted');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, 'config'), `[core]\n\tsshCommand = ${prog}\n`);
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
    await pushTaskBranch(input(), afterPreflight(() => undefined, seen));
    const dirs = seen.map((c) => c.args.find((a) => a.startsWith('--git-dir='))?.slice('--git-dir='.length)).filter((d): d is string => !!d && d !== common);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      expect(path.dirname(d)).toBe(path.join(root, 'clean'));
      expect(d).not.toBe(planted);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(seen.some((c) => c.env && 'GIT_CONFIG_NOSYSTEM' in c.env)).toBe(false);
    expect(fs.readdirSync(path.join(root, 'clean'))).toEqual(['c-planted']);
  });

  it('fetches into the recorded repository; a second fetch transfers nothing', async () => {
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(other, `f${i}.txt`), `${i}\n`);
      git(other, 'add', '.');
      git(other, 'commit', '-qm', `c${i}`);
    }
    git(other, 'push', '-q', 'origin', 'main');
    expect(await fetchTaskRefs(input(), undefined, FILE_OK)).toMatchObject({ ok: true, fetched: [{ ref: 'origin/main', sha: git(other, 'rev-parse', 'HEAD') }] });
    expect(git(repo, 'cat-file', '-t', git(other, 'rev-parse', 'HEAD'))).toBe('commit');
    const count = () => git(repo, 'count-objects', '-v');
    const before = count();
    expect(await fetchTaskRefs(input(), undefined, FILE_OK)).toMatchObject({ ok: true });
    expect(count()).toBe(before);
  });

  describe('refused with every local branch as it was', () => {
    const branches = () => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    const refusedBoth = async (why: RegExp) => {
      const before = branches();
      expect(await pushTaskBranch(input(), undefined, FILE_OK)).toMatchObject({ ok: false, error: expect.stringMatching(why) });
      expect(await fetchTaskRefs(input(), undefined, FILE_OK)).toMatchObject({ ok: false, error: expect.stringMatching(why) });
      expect(branches()).toBe(before);
      expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    };

    it('refs/remotes/origin is a link to the local branches', async () => {
      fs.rmSync(path.join(common, 'refs', 'remotes', 'origin'), { recursive: true, force: true });
      fs.symlinkSync(path.join(common, 'refs', 'heads'), path.join(common, 'refs', 'remotes', 'origin'));
      await refusedBoth(/is a link/);
    });

    it('packed-refs is a link', async () => {
      const elsewhere = path.join(root, 'elsewhere');
      fs.writeFileSync(elsewhere, '# pack-refs with: peeled fully-peeled sorted \n');
      fs.symlinkSync(elsewhere, path.join(common, 'packed-refs'));
      await refusedBoth(/packed-refs/);
      expect(fs.readFileSync(elsewhere, 'utf8')).toBe('# pack-refs with: peeled fully-peeled sorted \n');
    });

    it('a file where a folder of the ref must be', async () => {
      fs.writeFileSync(path.join(common, 'refs', 'remotes', 'origin', 'wtask'), `${git(repo, 'rev-parse', 'main')}\n`);
      const before = branches();
      expect(await pushTaskBranch(input(), undefined, FILE_OK)).toMatchObject({ ok: false, error: expect.stringMatching(/is not a folder/) });
      expect(branches()).toBe(before);
      expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    });


    it('a partial clone', async () => {
      git(repo, 'config', 'core.repositoryformatversion', '1');
      git(repo, 'config', 'extensions.partialClone', 'origin');
      await refusedBoth(/partial clone/);
    });
  });

  it('a shallow repository pushes and fetches, its shallow list copied into the clean dir and left as it was', async () => {
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(other, `s${i}.txt`), `${i}\n`);
      git(other, 'add', '.');
      git(other, 'commit', '-qm', `s${i}`);
    }
    git(other, 'push', '-q', 'origin', 'main');
    const shallowRepo = path.join(root, 'shallow-repo');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-local', origin, shallowRepo]);
    const shallowWt = path.join(root, 'shallow-wt');
    git(shallowRepo, 'worktree', 'add', '-q', '-b', 'wtask/one', shallowWt);
    fs.writeFileSync(path.join(shallowWt, 'w.txt'), 'w\n');
    git(shallowWt, 'add', '.');
    git(shallowWt, 'commit', '-qm', 'work');
    const shallowCommon = fs.realpathSync.native(path.join(shallowRepo, '.git'));
    const list = fs.readFileSync(path.join(shallowCommon, 'shallow'), 'utf8');
    const at = input({ worktreePath: shallowWt, gitCommonDir: shallowCommon });
    expect(await pushTaskBranch(at, undefined, FILE_OK)).toMatchObject({ ok: true, head: git(shallowWt, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(shallowWt, 'rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(other, 'later.txt'), 'later\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'later');
    git(other, 'push', '-q', 'origin', 'main');
    expect(await fetchTaskRefs(at, undefined, FILE_OK)).toMatchObject({ ok: true, fetched: [{ ref: 'origin/main', sha: git(other, 'rev-parse', 'HEAD') }, { ref: 'origin/wtask/one' }] });
    expect(fs.readFileSync(path.join(shallowCommon, 'shallow'), 'utf8')).toBe(list);
    // A list that is not commit ids is refused.
    fs.writeFileSync(path.join(shallowCommon, 'shallow'), 'not-a-commit\n');
    expect(await fetchTaskRefs(at, undefined, FILE_OK)).toMatchObject({ ok: false, error: expect.stringMatching(/shallow/) });
  });

  it('the owner\'s gc.auto=1 does not pack or prune the recorded repository\'s objects', async () => {
    fs.writeFileSync(gitconfig(), '[gc]\n\tauto = 1\n');
    const loose = [1, 2, 3].map((i) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: `loose ${i}\n`, encoding: 'utf8' }).trim());
    const packs = () => /^packs: (\d+)$/m.exec(git(repo, 'count-objects', '-v'))?.[1];
    const packsBefore = packs();
    expect(await pushTaskBranch(input(), undefined, FILE_OK)).toMatchObject({ ok: true });
    expect(await fetchTaskRefs(input(), undefined, FILE_OK)).toMatchObject({ ok: true });
    for (const sha of loose) expect(fs.existsSync(path.join(common, 'objects', sha.slice(0, 2), sha.slice(2)))).toBe(true);
    expect(packs()).toBe(packsBefore);
  });

  describe('the owner\'s own config still applies', () => {
    it('a global URL rewrite', async () => {
      fs.writeFileSync(gitconfig(), `[url "${origin}"]\n\tinsteadOf = https://example.invalid/o/r\n`);
      git(repo, 'remote', 'set-url', 'origin', 'https://example.invalid/o/r');
      expect(await pushTaskBranch(input(), undefined, FILE_OK)).toMatchObject({ ok: true });
      expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(wt, 'rev-parse', 'HEAD'));
    });

    it('an ssh command a global includeIf gitdir: adds for the repository', async () => {
      const inc = path.join(root, 'work.gitconfig');
      fs.writeFileSync(inc, `[core]\n\tsshCommand = ${prog}\n`);
      // The owner's folder rule, as in `[includeIf "gitdir:~/work/"]`.
      fs.writeFileSync(gitconfig(), `[includeIf "gitdir:${fs.realpathSync.native(repo)}/"]\n\tpath = ${inc}\n`);
      git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
      const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
      await pushTaskBranch(input(), afterPreflight(() => undefined, seen));
      expect(fs.existsSync(marker)).toBe(true);
      // It reached the network call by count, from the owner's global scope.
      expect(seen.some((c) => c.env?.GIT_CONFIG_KEY_0 === 'core.sshcommand' && c.env.GIT_CONFIG_VALUE_0 === prog)).toBe(true);
    });

    it('an ssh command a global includeIf hasconfig:remote.*.url: adds for origin\'s URL', async () => {
      const inc = path.join(root, 'work.gitconfig');
      fs.writeFileSync(inc, `[core]\n\tsshCommand = ${prog}\n`);
      fs.writeFileSync(gitconfig(), `[includeIf "hasconfig:remote.*.url:ssh://127.0.0.1:1/**"]\n\tpath = ${inc}\n`);
      git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
      await fetchTaskRefs(input());
      expect(fs.existsSync(marker)).toBe(true);
    });
  });
});
