import { describe, expect, it } from 'vitest';
import { groupWorkspacesByRepo, repoOwnerWorkspace, type ResolvedWorkspace } from '../repoGroups';

const w = (workspaceId: string, repoPath: string, mainPath: string, remoteKey: string | null = null): ResolvedWorkspace =>
  ({ workspaceId, repoPath, mainPath, remoteKey });
const live = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { name: `${id}-name`, pr: null }]));

describe('groupWorkspacesByRepo', () => {
  it('puts worktrees of one checkout together and the active repo first', () => {
    const groups = groupWorkspacesByRepo([
      w('a', '/code/alpha', '/code/alpha'),
      w('b', '/code/zeta', '/code/zeta'),
      w('c', '/code/zeta-wt/feat', '/code/zeta'),
    ], live('a', 'b', 'c'), 'c', 'linux');
    expect(groups.map((g) => g.name)).toEqual(['zeta', 'alpha']);
    expect(groups[0].active).toBe(true);
    expect(groups[0].checkouts).toHaveLength(1);
    expect(groups[0].checkouts[0].workspaces.map((x) => x.workspaceId)).toEqual(['b', 'c']);
    // The active pane's worktree gets the dot without changing the pinned checkout.
    expect(groups[0].checkouts[0].currentPath).toBe('/code/zeta-wt/feat');
    expect(groups[0].checkouts[0].mainPath).toBe('/code/zeta');
    expect(groups[1].checkouts[0].currentPath).toBeUndefined();
  });

  it('folds two clones of one remote into one group: one PR list, each clone its own checkout', () => {
    const groups = groupWorkspacesByRepo([
      w('a', '/code/wmux', '/code/wmux', 'github.com/o/wmux'),
      w('b', '/tmp/pr1745', '/tmp/pr1745', 'github.com/o/wmux'),
      w('c', '/code/other', '/code/other', 'github.com/o/other'),
    ], live('a', 'b', 'c'), 'b', 'linux');
    expect(groups.map((g) => g.name)).toEqual(['wmux', 'other']);
    expect(groups[0].checkouts.map((c) => c.label)).toEqual(['wmux', 'pr1745']);
    expect(groups[0].workspaceCount).toBe(2);
    // The PR list reads from the active workspace's checkout.
    expect(groups[0].prPath).toBe('/tmp/pr1745');
  });

  it('takes names from the live store and drops workspaces closed since resolution', () => {
    const groups = groupWorkspacesByRepo(
      [w('a', '/r', '/r'), w('gone', '/r', '/r')],
      { a: { name: 'Renamed', pr: { number: 3, state: 'open', checks: null, url: 'u' } } },
      null,
      'linux',
    );
    expect(groups[0].checkouts[0].workspaces).toEqual([
      { workspaceId: 'a', name: 'Renamed', pr: { number: 3, state: 'open', checks: null, url: 'u' }, repoPath: '/r' },
    ]);
  });

  it('lists the repos found in a non-repo workspace folder, without putting the workspace on them (#2438)', () => {
    const found = (workspaceId: string, repoPath: string, remoteKey: string | null = null): ResolvedWorkspace =>
      ({ workspaceId, repoPath, mainPath: repoPath, remoteKey, contained: true });
    const groups = groupWorkspacesByRepo([
      found('root', '/work/frontend', 'bitbucket.org/acme/frontend'),
      found('root', '/work/services/billing'),
      found('root', '/work/infra'),
      w('b', '/work/infra', '/work/infra'),
    ], live('root', 'b'), 'root', 'linux');
    // One group per repo, by name: none is "active", since the workspace is in none.
    expect(groups.map((g) => g.name)).toEqual(['billing', 'frontend', 'infra']);
    expect(groups.every((g) => !g.active)).toBe(true);
    const frontend = groups[1];
    expect(frontend.foundIn).toEqual(['root']);
    expect(frontend.workspaceCount).toBe(1);
    // No worktree row is marked as the found-in workspace's.
    expect(frontend.checkouts[0].workspaces).toEqual([]);
    expect(frontend.checkouts[0].currentPath).toBeUndefined();
    // Hand-offs from it still have a workspace to run from.
    expect(repoOwnerWorkspace(frontend, 'root')).toBe('root');
    // A workspace actually on the repo is listed on it, and owns it before the one it was found in.
    const infra = groups[2];
    expect(infra.checkouts[0].workspaces.map((x) => x.workspaceId)).toEqual(['b']);
    expect(infra.workspaceCount).toBe(2);
    expect(repoOwnerWorkspace(infra, null)).toBe('b');
  });

  it('a repo found below both the shell\'s folder and the agent\'s folder is one group, credited to the first', () => {
    const at = (root: string, byAgent: boolean): ResolvedWorkspace =>
      ({ workspaceId: 'root', repoPath: '/work/api', mainPath: '/work/api', remoteKey: null, contained: true, foundUnder: { root, byAgent } });
    const groups = groupWorkspacesByRepo([at('/work', false), at('/', true)], live('root'), 'root', 'linux');
    expect(groups).toHaveLength(1);
    expect(groups[0].foundIn).toEqual(['root']);
    expect(groups[0].workspaceCount).toBe(1);
    expect(groups[0].checkouts).toHaveLength(1);
    expect(groups[0].foundUnder.root).toEqual({ root: '/work', byAgent: false });
  });
});
