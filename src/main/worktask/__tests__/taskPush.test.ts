// task.push: main pushes a worker's own task branch (real git, local bare
// remote), and the RPC derives everything from the caller's pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pushTaskBranch, taskPushArgs, taskPushBranchRefusal } from '../taskPush';
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

  it('pushes exactly HEAD to refs/heads/<task branch>, fast-forward only', () => {
    const args = taskPushArgs('wtask/one', '/x/no-hooks');
    expect(args).toEqual(['-c', 'core.hooksPath=/x/no-hooks', 'push', '--no-verify', '--no-follow-tags', '--porcelain', '--set-upstream', 'origin', 'HEAD:refs/heads/wtask/one']);
    expect(args.some((a) => a.startsWith('+') || a.includes('force'))).toBe(false);
  });
});

describe('task.push RPC', () => {
  type Handler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
  const setup = (over: { row?: unknown; tasks?: unknown[]; caller?: string | null; repoDefault?: string | null } = {}) => {
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

  it('hands the repository\'s own default branch to the push, for any task', async () => {
    const { call, push } = setup({ repoDefault: 'trunk' });
    await call({ senderPtyId: 'pty-1' }, local);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ defaultBranches: expect.arrayContaining(['trunk']) }));
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
