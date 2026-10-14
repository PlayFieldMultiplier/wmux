// task.push: main pushes a worker's own task branch (real git, local bare
// remote), and the RPC derives everything from the caller's pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pushTaskBranch, taskPushArgs, taskPushBranchRefusal } from '../taskPush';
import { originUrlRepoKey } from '../workerGit';
import { registerTaskPushRpc } from '../../pipe/handlers/taskPush.rpc';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

describe('pushTaskBranch', () => {
  let root: string;
  let work: string;
  let origin: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'init');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-qb', 'wtask/one');
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const input = (branch = 'wtask/one') => ({ worktreePath: work, branch, defaultBranches: [], noHooksDir: path.join(root, 'no-hooks') });

  it('pushes HEAD to the task branch on origin and sets the upstream', async () => {
    const r = await pushTaskBranch(input());
    expect(r).toMatchObject({ ok: true, branch: 'wtask/one', remote: 'origin', head: git(work, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'config', '--get', 'branch.wtask/one.remote')).toBe('origin');
  });

  it('never force-pushes: a rewritten branch is rejected and the remote keeps its tip', async () => {
    expect((await pushTaskBranch(input())).ok).toBe(true);
    const before = git(origin, 'rev-parse', 'refs/heads/wtask/one');
    git(work, 'reset', '-q', '--hard', 'main');
    fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'rewrite');
    const r = await pushTaskBranch(input());
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(before);
  });

  it('pushes the branch alone: no tag follows it, whatever the repository config says', async () => {
    git(work, 'tag', '-a', 'v9', '-m', 'v9');
    git(work, 'config', 'push.followTags', 'true');
    expect((await pushTaskBranch(input())).ok).toBe(true);
    expect(git(origin, 'tag', '--list')).toBe('');
  });

  it('runs none of the worktree\'s own hooks', async () => {
    const hook = path.join(work, '.git', 'hooks', 'pre-push');
    const marker = path.join(root, 'hook-ran');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    expect((await pushTaskBranch(input())).ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a default branch, a recorded one and a name that is not a plain ref', async () => {
    expect(await pushTaskBranch(input('main'))).toMatchObject({ ok: false, reason: 'branch-refused' });
    expect(taskPushBranchRefusal('develop', ['develop'])).toMatch(/default branch/);
    expect(taskPushBranchRefusal('-f', [])).toMatch(/cannot be pushed/);
    expect(taskPushBranchRefusal('wtask/x', ['develop'])).toBeNull();
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('refuses a repository with no origin', async () => {
    git(work, 'remote', 'remove', 'origin');
    expect(await pushTaskBranch(input())).toMatchObject({ ok: false, reason: 'no-origin' });
  });

  it('pushes exactly HEAD to refs/heads/<task branch> at origin\'s URL, fast-forward only', () => {
    const args = taskPushArgs('wtask/one', 'git@github.com:o/r.git');
    expect(args).toEqual(['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', 'git@github.com:o/r.git', 'HEAD:refs/heads/wtask/one']);
    expect(args.some((a) => a.startsWith('+') || a.includes('force'))).toBe(false);
  });

  it('refuses when the repository config redirects the push or names a program, and runs none of it', async () => {
    const marker = path.join(root, 'program-ran');
    const prog = path.join(root, 'prog.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const other = path.join(root, 'other.git');
    execFileSync('git', ['init', '-q', '--bare', other]);
    const cases: Array<[string, string, string]> = [
      ['url.' + other + '.pushInsteadOf', origin, 'config-refused'],
      ['url.' + other + '.insteadOf', origin, 'config-refused'],
      ['remote.origin.pushurl', other, 'remote-refused'],
      ['remote.origin.receivepack', prog, 'config-refused'],
      ['core.fsmonitor', prog, 'config-refused'],
      ['core.sshCommand', prog, 'config-refused'],
      ['credential.helper', `!${prog}`, 'config-refused'],
      ['include.path', path.join(root, 'more.config'), 'config-refused'],
    ];
    for (const [key, value, reason] of cases) {
      git(work, 'config', key, value);
      expect(await pushTaskBranch(input()), key).toMatchObject({ ok: false, reason });
      git(work, 'config', '--unset-all', key);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(other, 'for-each-ref')).toBe('');
    // A renamed origin is no origin; an added remote is never pushed to.
    git(work, 'remote', 'rename', 'origin', 'up');
    expect(await pushTaskBranch(input())).toMatchObject({ ok: false, reason: 'no-origin' });
  });

  it('a bot\'s task lands only in the bot\'s repository', async () => {
    expect(await pushTaskBranch({ ...input(), expectedRepoKey: 'acme/app' })).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    expect(originUrlRepoKey('git@github.com:Acme/App.git')).toBe('github.com/acme/app');
    expect(originUrlRepoKey('https://github.com/acme/app')).toBe('github.com/acme/app');
    expect(originUrlRepoKey('ssh://git@github.com/acme/app.git')).toBe('github.com/acme/app');
    for (const bad of ['/srv/app.git', 'file:///srv/app.git', 'ext::sh -c x', 'https://github.com/acme/app/extra', '--upload-pack=x', 'ssh://git@github.com:22/acme/app.git']) {
      expect(originUrlRepoKey(bad), bad).toBeNull();
    }
  });
});

describe('task.push RPC', () => {
  type Handler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
  const setup = (over: { row?: unknown; tasks?: unknown[]; caller?: string | null; repoDefault?: string | null; botRepo?: string } = {}) => {
    const handlers = new Map<string, Handler>();
    const push = vi.fn(async (i: { branch: string }) => ({ ok: true as const, branch: i.branch, remote: 'origin' as const, head: 'abc', output: '' }));
    const row = over.row === undefined ? { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task' } : over.row;
    registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
      getWindow: () => null,
      daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: over.tasks ?? [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
      getLedger: () => ({ findOpenByTaskWorkspace: (ws: string) => (ws === 'ws-task' ? row : null) }) as never,
      resolveCallerWorkspace: async () => (over.caller === undefined ? 'ws-task' : over.caller),
      wmuxDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-')),
      push: push as never,
      repoDefaultBranch: async () => (over.repoDefault === undefined ? 'main' : over.repoDefault),
      botRepoKey: () => over.botRepo,
    });
    return { call: handlers.get('task.push')!, push };
  };
  const local = { origin: 'local' };

  it('pushes the branch of the caller\'s own task, named by main\'s record only', async () => {
    const { call, push } = setup();
    const r = await call({ senderPtyId: 'pty-1', branch: 'main', worktreePath: '/elsewhere' }, local);
    expect(r).toMatchObject({ ok: true, branch: 'wtask/one', taskId: 'wtask-1' });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ branch: 'wtask/one', worktreePath: '/w/one' }));
  });

  it('refuses a remote caller, a brain, a bot, an unresolvable pane and a pane with no task', async () => {
    expect(await setup().call({ senderPtyId: 'pty-1' }, {})).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, commanderWorkspace: 'ws-owner' })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, bot: { botId: 'bot-1' } })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: null }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: 'ws-other' }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('hands the push a reader of the repository\'s own default branch, for any task', async () => {
    const { call, push } = setup({ repoDefault: 'trunk' });
    await call({ senderPtyId: 'pty-1' }, local);
    const given = push.mock.calls[0][0] as unknown as { repoDefaultBranch: (k: string) => Promise<string | null>; expectedRepoKey?: string };
    expect(await given.repoDefaultBranch('github.com/o/r')).toBe('trunk');
    expect(given.expectedRepoKey).toBeUndefined();
  });

  it('pins a bot\'s task to the bot\'s repository, and refuses a bot that names none', async () => {
    const botRow = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { origin: { kind: 'bot', botId: 'bot-1', tainted: false } } };
    const pinned = setup({ row: botRow, botRepo: 'acme/app' });
    await pinned.call({ senderPtyId: 'pty-1' }, local);
    expect(pinned.push).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'acme/app' }));
    const none = setup({ row: botRow });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(none.push).not.toHaveBeenCalled();
  });

  it('refuses a detached checkout (verify) and a closed or branchless task', async () => {
    const detached = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { checkout: { sha: 'a'.repeat(40), detached: true } } } });
    expect(await detached.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(detached.push).not.toHaveBeenCalled();
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'closed', branch: 'b', worktreePath: '/w' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'open' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});
