// task.push / task.fetch run main's network git in a main-owned relay that
// borrows the recorded repository's objects; main writes nothing under the
// recorded repository (real git where it can run here; the WSL shape by its
// argv and env).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, pushTaskBranch, type TaskPushExec, type TaskPushGit } from '../taskPush';
import { fetchTaskRefs } from '../taskFetch';
import {
  fetchCommandFor, gitVersionRefusal, parseRawGitConfigList, relayGitConfigArgs, shellQuote, transportConfigReplay,
} from '../../../shared/taskGitRelay';
import { writeFakeSsh } from '../../../test-utils/fakeSsh';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

const FILE_OK = { protocols: ['https', 'ssh', 'file'] };

describe('relay git: argv, env and config replay', () => {
  it('forces no gc, no maintenance, no commit-graph or multi-pack index, and the given transports', () => {
    expect(relayGitConfigArgs(['-c', 'core.fsmonitor=false'])).toEqual([
      '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    ]);
  });

  const list = (rows: Array<[string, string, string]>) => rows.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join('');

  it('resets then replays a transport key the owner changed for the repository, and only adds a URL rewrite', () => {
    const relay = parseRawGitConfigList(list([
      ['global', 'http.sslVerify', 'false'],
      ['global', 'credential.helper', 'store'],
    ]));
    const context = parseRawGitConfigList(list([
      ['global', 'http.sslVerify', 'false'],
      ['global', 'credential.helper', 'store'],
      // Added for the recorded repository by an includeIf gitdir: rule.
      ['global', 'http.sslVerify', 'true'],
      ['global', 'credential.helper', ''],
      ['global', 'url.git@work:Team/.insteadOf', 'https://work/Team/'],
      ['global', 'core.sshcommand', 'ssh -i key'],
    ]));
    expect(transportConfigReplay(context, relay)).toEqual([
      'http.sslVerify=', 'http.sslVerify=false', 'http.sslVerify=true',
      'credential.helper=', 'credential.helper=store', 'credential.helper=',
      'url.git@work:Team/.insteadOf=https://work/Team/',
      'core.sshcommand=', 'core.sshcommand=ssh -i key',
    ]);
    expect(transportConfigReplay(relay, relay)).toEqual([]);
    // A URL rewrite is never reset (an empty base matches every URL).
    expect(transportConfigReplay(context, relay).some((kv) => kv === 'url.git@work:Team/.insteadOf=')).toBe(false);
  });

  it('reads the version floor', () => {
    expect(gitVersionRefusal('git version 2.50.1 (Apple Git-155)')).toBeNull();
    expect(gitVersionRefusal('git version 2.43.4')).toBeNull();
    expect(gitVersionRefusal('git version 2.43.3')).toMatch(/older than 2\.43\.4/);
    expect(gitVersionRefusal('git version 2.39.0')).toMatch(/older than/);
    expect(gitVersionRefusal('git version 3.0.0')).toBeNull();
    expect(gitVersionRefusal('nonsense')).toMatch(/could not be read/);
  });

  it('quotes the fetch line for the worker\'s shell', () => {
    expect(shellQuote("a b", 'linux')).toBe("'a b'");
    expect(shellQuote("a'b", 'darwin')).toBe("'a'\\''b'");
    expect(shellQuote('a b', 'win32')).toBe('"a b"');
    expect(fetchCommandFor('/r e/relay', ['+refs/heads/main:refs/remotes/origin/main'], 'linux'))
      .toBe("git fetch --no-tags --no-write-fetch-head '/r e/relay' '+refs/heads/main:refs/remotes/origin/main'");
  });
});

describe('relay git: inside WSL', () => {
  it('runs the network call in the distro with the relay\'s drvfs path, borrowed objects, no GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR and no GIT_CONFIG_NOSYSTEM', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-wsl-')));
    const relayRoot = path.join(root, 'relay');
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const sha = 'a'.repeat(40);
    const exec: TaskPushExec = async (_file, args, env) => {
      calls.push({ args, env });
      const prog = args[5];
      if (prog === 'wslpath') return { code: 0, stdout: `/mnt/c/wmux${String(args[args.length - 1]).slice(root.length).replace(/\\/g, '/')}\n`, stderr: '' };
      if (args.includes('--version')) return { code: 0, stdout: 'git version 2.50.0\n', stderr: '' };
      if (args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@github.com/acme/app.git\0', stderr: '' };
      if (args.includes('--is-shallow-repository')) return { code: 0, stdout: 'false\n', stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${sha}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await pushTaskBranch(
        { worktreePath: 'C:\\Users\\me\\.wmux\\worktrees\\h\\t', branch: 'wtask/one', defaultBranches: [], noHooksDir: 'C:\\Users\\me\\.wmux\\factory\\no-hooks', gitCommonDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git', gitWorktreeDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\worktrees\\t', relayRoot, taskId: 'wtask-1' },
        async () => ({ code: 1, stdout: '', stderr: 'host git' }),
        { platform: 'win32', wslExec: exec },
      );
      expect(r).toMatchObject({ ok: true, head: sha });
      const push = calls.find((c) => c.args.includes('push'));
      expect(push).toBeDefined();
      const { args, env } = push as { args: string[]; env: NodeJS.ProcessEnv };
      expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/', '--exec', 'git']);
      expect(args[6]).toMatch(/^--git-dir=\/mnt\/c\/wmux\/relay\/wtask-1$/);
      expect(args).toEqual(expect.arrayContaining(['protocol.allow=never', 'gc.auto=0', 'core.hooksPath=/dev/null']));
      // A relay call never names the recorded objects or common dir by env.
      expect('GIT_OBJECT_DIRECTORY' in env).toBe(false);
      expect('GIT_COMMON_DIR' in env).toBe(false);
      expect(env.GIT_DIR).toBeUndefined();
      expect(calls.some((c) => 'GIT_CONFIG_NOSYSTEM' in c.env)).toBe(false);
      // The borrowed objects are named by the alternates file (a Linux path).
      expect(fs.readFileSync(path.join(relayRoot, 'wtask-1', 'objects', 'info', 'alternates'), 'utf8')).toBe('/home/me/repo/.git/objects\n');
      // HEAD is read through the recorded worktree git dir, by env.
      const head = calls.find((c) => c.args.includes('HEAD^{commit}')) as { args: string[]; env: NodeJS.ProcessEnv };
      expect(head.env.GIT_DIR).toBe('/home/me/repo/.git/worktrees/t');
      expect(head.env.GIT_COMMON_DIR).toBe('/home/me/repo/.git');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('relay git: real git', () => {
  let root: string;
  let origin: string;
  let repo: string;
  let work: string;
  let common: string;
  let wtGitDir: string;
  let other: string;
  let otherOrigin: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-git-')));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    work = path.join(root, 'work');
    other = path.join(root, 'other');
    otherOrigin = path.join(root, 'other-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', otherOrigin]);
    for (const [dir, remote] of [[repo, origin], [other, otherOrigin]]) {
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      fs.writeFileSync(path.join(dir, 'a.txt'), `${dir}\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'init');
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', 'origin', 'main');
    }
    git(repo, 'worktree', 'add', '-q', '-b', 'wtask/one', work);
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
    common = fs.realpathSync.native(path.join(repo, '.git'));
    wtGitDir = fs.realpathSync.native(git(work, 'rev-parse', '--path-format=absolute', '--git-dir'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), '.gitconfig'), { force: true });
  });

  const input = (over: Record<string, unknown> = {}) => ({
    worktreePath: work, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh'),
    gitCommonDir: common, gitWorktreeDir: wtGitDir, relayRoot: path.join(root, 'relay'), taskId: 'wtask-1', ...over,
  });

  // A stable, order-independent hash of every file under a directory: its
  // relative path, its lstat kind, and (for a plain file) its bytes.
  const hashTree = (dir: string): string => {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const name of fs.readdirSync(d).sort()) {
        const abs = path.join(d, name);
        const r = path.posix.join(rel, name);
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) out.push(`L ${r} -> ${fs.readlinkSync(abs)}`);
        else if (st.isDirectory()) { out.push(`D ${r}`); walk(abs, r); }
        else if (st.isFile()) out.push(`F ${r} ${execFileSync('shasum', [abs]).toString().split(' ')[0]}`);
        else out.push(`O ${r}`);
      }
    };
    walk(dir, '');
    return out.join('\n');
  };
  const runFetchLine = (cmd: string) => {
    const m = /^git fetch --no-tags --no-write-fetch-head (['"])(.*?)\1 (.+)$/.exec(cmd)!;
    const refspecs = m[3].split(' ').map((r) => r.replace(/^(['"])(.*)\1$/, '$2'));
    git(work, 'fetch', '--no-tags', m[2], ...refspecs);
  };

  it('tree-hash invariant: push and fetch leave the recorded repository byte-identical, with objects/pack and a reflog leaf symlinked out', async () => {
    // A Codex worker has symlinked objects/pack out and planted a symlinked reflog leaf.
    const extPack = path.join(root, 'ext-pack');
    fs.mkdirSync(extPack);
    fs.rmSync(path.join(common, 'objects', 'pack'), { recursive: true, force: true });
    fs.symlinkSync(extPack, path.join(common, 'objects', 'pack'));
    const extLog = path.join(root, 'ext-log');
    fs.writeFileSync(extLog, 'owner reflog\n');
    fs.mkdirSync(path.join(common, 'logs', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.rmSync(path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main'), { force: true });
    fs.symlinkSync(extLog, path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main'));
    // Another clone of origin moves main so the fetch has real work.
    const mover = path.join(root, 'mover');
    execFileSync('git', ['clone', '-q', origin, mover]);
    fs.writeFileSync(path.join(mover, 'c.txt'), 'c\n');
    git(mover, 'add', '.');
    git(mover, 'commit', '-qm', 'moved');
    git(mover, 'push', '-q', 'origin', 'main');

    const before = hashTree(common);
    const extBefore = fs.readFileSync(extLog, 'utf8');
    const extPackBefore = fs.readdirSync(extPack);

    const pushed = await pushTaskBranch(input(), undefined, FILE_OK);
    expect(pushed).toMatchObject({ ok: true, head: git(work, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));

    const fetched = await fetchTaskRefs(input(), undefined, FILE_OK);
    expect(fetched).toMatchObject({ ok: true });
    expect((fetched as { fetched: Array<{ ref: string; sha: string }> }).fetched).toContainEqual({ ref: 'origin/main', sha: git(mover, 'rev-parse', 'HEAD') });

    // Nothing under the recorded repository changed, and nothing was written
    // through the symlinks.
    expect(hashTree(common)).toBe(before);
    expect(fs.readFileSync(extLog, 'utf8')).toBe(extBefore);
    expect(fs.readdirSync(extPack)).toEqual(extPackBefore);

    // The worker's fetch line brings the branch in, from the relay.
    runFetchLine((fetched as { fetchCommand: string }).fetchCommand);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(mover, 'rev-parse', 'HEAD'));
  });

  it('a worktree .git changed during the call does not change where the push goes: the recorded origin', async () => {
    const before = hashTree(common);
    // After main reads the recorded config, the worktree's .git is rewritten.
    const hook: TaskPushGit = async (args, cwd, env) => {
      const r = await defaultGit(args, cwd, env);
      if (args.includes('--list')) {
        try { fs.writeFileSync(path.join(work, '.git'), `gitdir: ${path.join(other, '.git', 'worktrees', 'x')}\n`); } catch { /* ignore */ }
      }
      return r;
    };
    const headSha = git(work, 'rev-parse', 'HEAD');
    const pushed = await pushTaskBranch(input(), hook, FILE_OK);
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ ok: true, head: headSha });
    // The push went to the recorded origin, not the one the worktree .git now names.
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(headSha);
    expect(git(otherOrigin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(hashTree(common)).toBe(before);
  });

  it('config replay: an includeIf gitdir: sshCommand reaches the relay; a reset clears an unconditional one', async () => {
    const marker = path.join(root, 'ssh-ran');
    const prog = path.join(root, 'ssh.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
    const inc = path.join(root, 'work.gitconfig');
    fs.writeFileSync(inc, `[core]\n\tsshCommand = ${prog}\n`);
    fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`);
    await pushTaskBranch(input());
    expect(fs.existsSync(marker)).toBe(true);

    // Reset: unconditional sshCommand, cleared for the repository by the include.
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(inc, '[core]\n\tsshCommand = \n');
    fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[core]\n\tsshCommand = ${prog}\n[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`);
    await fetchTaskRefs(input());
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the recorded repository keeps its object format; a second fetch transfers nothing, and a shallow repository works', async () => {
    const shallowRepo = path.join(root, 'shallow-repo');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-local', origin, shallowRepo]);
    const shallowWt = path.join(root, 'shallow-wt');
    git(shallowRepo, 'worktree', 'add', '-q', '-b', 'wtask/two', shallowWt);
    fs.writeFileSync(path.join(shallowWt, 'w.txt'), 'w\n');
    git(shallowWt, 'add', '.');
    git(shallowWt, 'commit', '-qm', 'work');
    const sCommon = fs.realpathSync.native(path.join(shallowRepo, '.git'));
    const sWt = fs.realpathSync.native(git(shallowWt, 'rev-parse', '--path-format=absolute', '--git-dir'));
    const sInput = { worktreePath: shallowWt, branch: 'wtask/two', defaultBranches: [], noHooksDir: path.join(root, 'nh'), gitCommonDir: sCommon, gitWorktreeDir: sWt, relayRoot: path.join(root, 'relay-s'), taskId: 'wtask-2' };
    const before = hashTree(sCommon);
    expect(await pushTaskBranch(sInput, undefined, FILE_OK)).toMatchObject({ ok: true });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/two')).toBe(git(shallowWt, 'rev-parse', 'HEAD'));
    expect(await fetchTaskRefs(sInput, undefined, FILE_OK)).toMatchObject({ ok: true });
    const second = await fetchTaskRefs(sInput, undefined, FILE_OK);
    expect(second).toMatchObject({ ok: true });
    expect(hashTree(sCommon)).toBe(before);
  });

  it('never sets GIT_CONFIG_NOSYSTEM on any call', async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const spy: TaskPushGit = async (args, cwd, env) => { envs.push(env); return defaultGit(args, cwd, env); };
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: true });
    expect(envs.some((e) => e && 'GIT_CONFIG_NOSYSTEM' in e)).toBe(false);
    expect(envs.some((e) => e && 'GIT_CONFIG_GLOBAL' in e)).toBe(false);
  });
});
