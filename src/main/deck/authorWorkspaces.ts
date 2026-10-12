// ─── The workspaces that authored a PR — the merge lane's "who is not a verifier"
//
// authorWorkspaces = the asker of the merge
//                  ∪ the task workspaces of task ledger rows whose task branch
//                    (daemon task.mission.list) is the PR's head branch
//                  ∪ the workspaces with a pane whose cwd lies in a worktree
//                    that has the head branch checked out.
//
// Unlike askerBranches, nothing here is swallowed: a ledger that throws, a
// daemon that is not connected or answers an error, a `git worktree list`
// that fails, or a workspace mirror that was never filled makes the whole
// answer unknown (a throw), and the lane fails `author-unknown`.

import * as path from 'node:path';

export interface AuthorWorkspacesDeps {
  /** Every task ledger row. */
  listLedger: () => ReadonlyArray<{ id: string; taskWorkspaceId: string; ownerWorkspaceId: string }>;
  /** The daemon's RPC, or null when it is not connected. */
  daemonRpc: () => ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null;
  /** Every worktree of `repoPath` and the branch it has checked out (null:
   *  detached). Throws when git cannot answer. */
  worktrees: (repoPath: string) => Promise<Array<{ path: string; branch: string | null }>>;
  /** Every pane's cwd by workspace, or null when the mirror is unknown. */
  paneCwds: () => Array<{ workspaceId: string; cwd: string }> | null;
  /** A path with its symlinks resolved (identity when it cannot be). */
  realpath?: (p: string) => string;
}

/** `child` is `dir` or lies under it. */
function within(child: string, dir: string): boolean {
  const rel = path.relative(dir, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Throws when any source cannot be read. */
export async function authorWorkspaces(
  deps: AuthorWorkspacesDeps,
  input: { askerWorkspaceId: string; repoPath: string; headRefName: string },
): Promise<string[]> {
  const { askerWorkspaceId, repoPath, headRefName } = input;
  if (!headRefName) throw new Error('no head branch');
  const out = new Set<string>([askerWorkspaceId]);

  const rows = deps.listLedger();
  if (rows.length > 0) {
    const rpc = deps.daemonRpc();
    if (!rpc) throw new Error('daemon not connected');
    for (const owner of new Set(rows.map((r) => r.ownerWorkspaceId))) {
      const res = (await rpc('task.mission.list', { verifiedWorkspaceId: owner })) as { ok?: unknown; tasks?: unknown };
      if (!res || res.ok === false || !Array.isArray(res.tasks)) throw new Error('task.mission.list failed');
      for (const t of res.tasks as Array<{ id?: unknown; branch?: unknown }>) {
        if (t.branch !== headRefName) continue;
        for (const r of rows) if (r.id === t.id && r.ownerWorkspaceId === owner) out.add(r.taskWorkspaceId);
      }
    }
  }

  const real = deps.realpath ?? ((p: string) => p);
  const trees = (await deps.worktrees(repoPath)).map((t) => ({ path: real(t.path), branch: t.branch }));
  if (trees.some((t) => t.branch === headRefName)) {
    const panes = deps.paneCwds();
    if (!panes) throw new Error('workspace mirror unknown');
    for (const p of panes) {
      if (!p.cwd) continue;
      const cwd = real(p.cwd);
      // The innermost worktree holding the cwd (one can be nested in another).
      let home: { path: string; branch: string | null } | null = null;
      for (const t of trees) if (within(cwd, t.path) && (!home || t.path.length > home.path.length)) home = t;
      if (home?.branch === headRefName) out.add(p.workspaceId);
    }
  }
  return [...out];
}

/** The worktrees `git worktree list --porcelain` names, each with the
 *  branch it has checked out (null when detached). */
export function parseWorktreeList(porcelain: string): Array<{ path: string; branch: string | null }> {
  const out: Array<{ path: string; branch: string | null }> = [];
  for (const line of porcelain.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (l.startsWith('worktree ')) out.push({ path: l.slice('worktree '.length), branch: null });
    else if (l.startsWith('branch refs/heads/') && out.length > 0) out[out.length - 1].branch = l.slice('branch refs/heads/'.length);
  }
  return out;
}
