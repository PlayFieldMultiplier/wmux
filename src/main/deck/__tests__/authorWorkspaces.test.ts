// The PR's author workspaces: the asker, task workspaces on the head branch,
// and workspaces with a pane in a worktree of it. Any unreadable source is a
// throw (the lane's `author-unknown`), never a smaller set.
import { describe, it, expect } from 'vitest';
import { authorWorkspaces, parseWorktreeList, type AuthorWorkspacesDeps } from '../authorWorkspaces';

const INPUT = { askerWorkspaceId: 'ws-asker', repoPath: '/repo', headRefName: 'feat/x' };

function deps(over: Partial<AuthorWorkspacesDeps> = {}): AuthorWorkspacesDeps {
  return {
    listLedger: () => [
      { id: 't1', taskWorkspaceId: 'ws-task1', ownerWorkspaceId: 'ws-lead' },
      { id: 't2', taskWorkspaceId: 'ws-task2', ownerWorkspaceId: 'ws-lead' },
    ],
    daemonRpc: () => async (_m, p) => ({
      ok: true,
      tasks: p.verifiedWorkspaceId === 'ws-lead' ? [{ id: 't1', branch: 'feat/x' }, { id: 't2', branch: 'feat/y' }] : [],
    }),
    workspaceIds: () => ['ws-asker', 'ws-pane', 'ws-verifier', 'ws-main'],
    worktrees: async () => [
      { path: '/repo', branch: 'main' },
      { path: '/wt/feat-x', branch: 'feat/x' },
      { path: '/wt/verify', branch: null },
    ],
    paneCwds: () => [
      { workspaceId: 'ws-pane', cwd: '/wt/feat-x/src' },
      { workspaceId: 'ws-verifier', cwd: '/wt/verify' },
      { workspaceId: 'ws-main', cwd: '/repo' },
    ],
    ...over,
  };
}

describe('authorWorkspaces', () => {
  it('unions the asker, task workspaces on the branch and panes in its worktree', async () => {
    expect((await authorWorkspaces(deps(), INPUT)).sort()).toEqual(['ws-asker', 'ws-pane', 'ws-task1']);
  });

  it('a task on the branch counts by its own workspace even without a ledger row', async () => {
    const d = deps({
      listLedger: () => [],
      daemonRpc: () => async (_m, p) => ({
        ok: true, tasks: p.verifiedWorkspaceId === 'ws-main' ? [{ id: 't9', branch: 'feat/x', paneGroupId: 'ws-task9' }] : [],
      }),
    });
    expect((await authorWorkspaces(d, INPUT)).sort()).toEqual(['ws-asker', 'ws-pane', 'ws-task9']);
  });

  it('a pane in a worktree nested inside the branch checkout counts by its own worktree', async () => {
    const d = deps({
      worktrees: async () => [{ path: '/repo', branch: 'feat/x' }, { path: '/repo/.wt/verify', branch: null }],
      paneCwds: () => [{ workspaceId: 'ws-verifier', cwd: '/repo/.wt/verify' }, { workspaceId: 'ws-main', cwd: '/repo/src' }],
    });
    expect((await authorWorkspaces(d, INPUT)).sort()).toEqual(['ws-asker', 'ws-main', 'ws-task1']);
  });

  it('a disconnected daemon, a failed RPC or a throwing ledger is unknown', async () => {
    await expect(authorWorkspaces(deps({ daemonRpc: () => null }), INPUT)).rejects.toThrow('daemon not connected');
    await expect(authorWorkspaces(deps({ daemonRpc: () => async () => ({ ok: false }) }), INPUT)).rejects.toThrow();
    await expect(authorWorkspaces(deps({ daemonRpc: () => async () => { throw new Error('timeout'); } }), INPUT)).rejects.toThrow();
    await expect(authorWorkspaces(deps({ listLedger: () => { throw new Error('ledger'); } }), INPUT)).rejects.toThrow('ledger');
  });

  it('git or the workspace mirror failing is unknown', async () => {
    await expect(authorWorkspaces(deps({ worktrees: async () => { throw new Error('git'); } }), INPUT)).rejects.toThrow('git');
    await expect(authorWorkspaces(deps({ paneCwds: () => null }), INPUT)).rejects.toThrow('workspace mirror unknown');
    await expect(authorWorkspaces(deps({ workspaceIds: () => null }), INPUT)).rejects.toThrow('workspace mirror unknown');
  });

  it('parses git worktree list --porcelain', () => {
    const out = 'worktree /repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree /wt/v\nHEAD 2222\ndetached\n\nworktree /wt/x\nHEAD 3333\nbranch refs/heads/feat/x\n';
    expect(parseWorktreeList(out)).toEqual([
      { path: '/repo', branch: 'main' }, { path: '/wt/v', branch: null }, { path: '/wt/x', branch: 'feat/x' },
    ]);
  });
});
