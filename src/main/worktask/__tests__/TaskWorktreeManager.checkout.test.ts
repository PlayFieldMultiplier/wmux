// Detached task checkouts (verify preset): the commit must exist (after an
// optional single-ref fetch), submodules/LFS are refused like resolveBase, a
// refspec is never fetched, and the worktree is added with --detach (no -b).

import { describe, expect, it } from 'vitest';
import { TaskWorktreeManager, type TaskWorktreePlan } from '../TaskWorktreeManager';

const SHA = 'd'.repeat(40);

function fakeGit(handler: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  const runGit = async (args: string[]) => {
    calls.push(args);
    const out = handler(args);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: '' };
  };
  return { calls, mgr: new TaskWorktreeManager({ runGit: runGit as never }) };
}

const healthy = (args: string[]): string | Error => {
  if (args[0] === 'rev-parse') return `${SHA}\n`;
  if (args[0] === 'cat-file' || args[0] === 'show' || args[0] === 'config') return new Error('absent');
  return '';
};

describe('TaskWorktreeManager detached checkout', () => {
  it('fetches the single ref, then verifies the commit', async () => {
    const { mgr, calls } = fakeGit(healthy);
    expect(await mgr.resolveCheckout('/repo', SHA, 'pull/12/head')).toEqual({ oid: SHA });
    expect(calls.find((c) => c[0] === 'fetch')).toEqual(['fetch', 'origin', 'pull/12/head']);
  });

  it('refuses a refspec, a bad sha, a missing commit, and a commit with submodules', async () => {
    const { mgr, calls } = fakeGit(healthy);
    expect(await mgr.resolveCheckout('/repo', SHA, '+refs/heads/main:refs/heads/main')).toHaveProperty('error');
    expect(await mgr.resolveCheckout('/repo', SHA, 'a:b')).toHaveProperty('error');
    expect(calls.some((c) => c[0] === 'fetch')).toBe(false);
    expect(await mgr.resolveCheckout('/repo', 'nope')).toHaveProperty('error');
    const missing = fakeGit((a) => (a[0] === 'rev-parse' ? new Error('unknown revision') : ''));
    expect(await missing.mgr.resolveCheckout('/repo', SHA)).toHaveProperty('error');
    const sub = fakeGit((a) => (a[0] === 'rev-parse' ? `${SHA}\n` : a[0] === 'cat-file' ? '' : new Error('absent')));
    expect(await sub.mgr.resolveCheckout('/repo', SHA)).toMatchObject({ error: expect.stringMatching(/submodules/) });
  });

  it('adds the worktree with --detach at the commit and creates no branch', async () => {
    const { mgr, calls } = fakeGit(healthy);
    const plan: TaskWorktreePlan = {
      repoRoot: '/repo', repoHash: 'h', taskSlug: 's', worktreePath: '/tmp/wt-s', branch: 'wtask/s', metaDir: '/tmp/meta-s',
    };
    const res = await mgr.createDetachedWorktree(plan, SHA);
    expect(res).toMatchObject({ ok: true, branch: '' });
    const add = calls.find((c) => c[0] === 'worktree');
    expect(add?.slice(0, 3)).toEqual(['worktree', 'add', '--detach']);
    expect(add).not.toContain('-b');
    expect(add?.at(-1)).toBe(SHA);
  });
});
