// All repos on the Git page: every open workspace resolved to its worktree,
// that worktree's checkout (main worktree) and the checkout's remote, then
// grouped by remote — two clones of one GitHub repo are one group with one
// PR list and each clone's worktrees labelled by checkout. A checkout with no
// remote is its own group.
//
// Resolution goes through the shared TTL caches (repoCache), so N workspaces
// on one repo cost one `worktree.list` and one remote read, and it reruns only
// when a workspace's cwd candidates change, not on every name or PR update:
// names and PR badges are joined from the live store at render.
//
// A workspace whose folder is not a repo but holds repos in its subfolders
// (#2438) is listed under each of them as "found in" that workspace: the repo
// gets its group, but the workspace does not sit on any of its worktrees, so
// no row is marked as its and the group is not the active one.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import type { PrStatus } from '../../../shared/types';
import { normWorktreePath, type WorkspaceOnRepo } from './worktreeRows';
import { hostPlatform, pathLeaf, repoCwdCandidates } from './GitTab';
import { mainPathCached, repoKeyCached, resolveRepoCached, scanReposCached } from './repoCache';

export interface ResolvedWorkspace {
  workspaceId: string;
  /** The workspace's worktree toplevel. */
  repoPath: string;
  /** That worktree's checkout (main worktree). */
  mainPath: string;
  /** The checkout's remote identity (host/owner/repo), null without one. */
  remoteKey: string | null;
  /** The repo was found in a subfolder of the workspace's folder, which is
   *  not a repo itself (#2438): the workspace is not on this repo. */
  contained?: boolean;
}

export interface Checkout {
  mainPath: string;
  /** The checkout's folder, telling clones of one repo apart. */
  label: string;
  workspaces: WorkspaceOnRepo[];
  /** The active workspace's worktree when it sits in this checkout. */
  currentPath?: string;
}

export interface RepoGroup {
  key: string;
  name: string;
  checkouts: Checkout[];
  /** The active workspace sits in this repo. */
  active: boolean;
  /** Where the group's one PR list is read from (any checkout serves). */
  prPath: string;
  workspaceCount: number;
  /** Workspaces whose folder holds this repo in a subfolder (#2438). */
  foundIn: string[];
}

type Live = Record<string, { name: string; pr: PrStatus | null }>;

/** The workspace that owns a repo group's hand-offs (the fan-out runs from
 *  it): the active workspace when it is in the group, else the group's first
 *  workspace; undefined when none is open on it. */
export function repoOwnerWorkspace(group: Pick<RepoGroup, 'checkouts'> & { foundIn?: readonly string[] }, activeWorkspaceId: string | null): string | undefined {
  // Workspaces on the repo first; a workspace it was only found in otherwise.
  const all = [...group.checkouts.flatMap((c) => c.workspaces.map((w) => w.workspaceId)), ...(group.foundIn ?? [])];
  if (activeWorkspaceId && all.includes(activeWorkspaceId)) return activeWorkspaceId;
  return all[0];
}

/** The group a repo path belongs to: its list path, a checkout (clone) of
 *  it, or a workspace's worktree in it; undefined when none. A selection made
 *  from a clone or a worktree is that group's, not "no group". */
export function groupOfPath<G extends Pick<RepoGroup, 'prPath' | 'checkouts'>>(groups: readonly G[], repoPath: string, platform?: string): G | undefined {
  const p = normWorktreePath(repoPath, platform);
  return groups.find((g) => normWorktreePath(g.prPath, platform) === p
    || g.checkouts.some((c) => normWorktreePath(c.mainPath, platform) === p
      || c.workspaces.some((w) => !!w.repoPath && normWorktreePath(w.repoPath, platform) === p)));
}

/** Group resolved workspaces by remote (else checkout); the active repo first, then by name. */
export function groupWorkspacesByRepo(
  list: readonly ResolvedWorkspace[],
  live: Live,
  activeWorkspaceId: string | null,
  platform?: string,
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const w of list) {
    const info = live[w.workspaceId];
    if (!info) continue; // closed since it was resolved
    const key = w.remoteKey ?? `path:${normWorktreePath(w.mainPath, platform)}`;
    let g = groups.get(key);
    if (!g) {
      const name = w.remoteKey ? w.remoteKey.split('/').pop() ?? pathLeaf(w.mainPath) : pathLeaf(w.mainPath);
      g = { key, name, checkouts: [], active: false, prPath: w.mainPath, workspaceCount: 0, foundIn: [] };
      groups.set(key, g);
    }
    const ck = normWorktreePath(w.mainPath, platform);
    let c = g.checkouts.find((x) => normWorktreePath(x.mainPath, platform) === ck);
    if (!c) {
      c = { mainPath: w.mainPath, label: pathLeaf(w.mainPath), workspaces: [] };
      g.checkouts.push(c);
    }
    // A workspace counts once per group, however many of its checkouts it is in or holds.
    const counted = g.foundIn.includes(w.workspaceId) || g.checkouts.some((x) => x.workspaces.some((y) => y.workspaceId === w.workspaceId));
    if (w.contained) {
      if (!g.foundIn.includes(w.workspaceId)) g.foundIn.push(w.workspaceId);
      if (!counted) g.workspaceCount++;
      continue;
    }
    c.workspaces.push({ workspaceId: w.workspaceId, name: info.name, pr: info.pr, repoPath: w.repoPath });
    if (!counted) g.workspaceCount++;
    if (w.workspaceId === activeWorkspaceId) {
      g.active = true;
      g.prPath = w.mainPath;
      c.currentPath = w.repoPath;
    }
  }
  return [...groups.values()].sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
}

type ResolveRepo = (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>;
type ListWorktrees = (repoPath: string) => Promise<{ ok: true; mainPath: string; worktrees: { path: string }[] } | { ok: false }>;
type RepoKey = (repoPath: string) => Promise<{ key: string | null }>;
type ScanRepos = (cwd: string) => Promise<{ ok: true; repoPaths: string[] } | { ok: false }>;

/** Each workspace's id and cwd candidates — the only inputs to resolution. */
function selectResolutionKey(s: StoreState): string {
  return s.workspaces.map((w) => `${w.id}\u0001${repoCwdCandidates(w, s.startupDirectory || '', true).join('\u0002')}`).join('\n');
}

function selectLive(s: StoreState): string[] {
  return s.workspaces.map((w) => `${w.id}\u0001${w.name}\u0001${w.metadata?.pr ? JSON.stringify(w.metadata.pr) : ''}`);
}

/** Groups for All repos and the header's repo menu; null while the first
 *  resolution runs. Nothing is read while `enabled` is false. */
export function useRepoGroups(refreshKey: number, enabled = true): RepoGroup[] | null {
  const resolutionKey = useStore(selectResolutionKey);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const liveRows = useStore(useShallow(selectLive));
  const [resolved, setResolved] = useState<ResolvedWorkspace[] | null>(null);
  // A hidden window reads nothing; showing it again resumes.
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const seq = useRef(0);
  const lastRefresh = useRef(refreshKey);

  useEffect(() => {
    const mine = ++seq.current;
    if (hidden || !enabled) return undefined;
    const force = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    const api = (window as unknown as {
      electronAPI?: { diff?: { resolveRepo?: ResolveRepo; scanRepos?: ScanRepos }; worktree?: { list?: ListWorktrees }; github?: { repoKey?: RepoKey } };
    }).electronAPI;
    const resolveRepo = api?.diff?.resolveRepo;
    const list = api?.worktree?.list;
    if (!resolveRepo || !list) {
      setResolved([]);
      return undefined;
    }
    const live = () => seq.current === mine && !document.hidden;
    void (async () => {
      const state = useStore.getState();
      const plat = hostPlatform();
      const out: ResolvedWorkspace[] = [];
      for (const ws of state.workspaces) {
        const candidates = repoCwdCandidates(ws, state.startupDirectory || '', true);
        let top: string | null = null;
        for (const cwd of candidates) {
          top = await resolveRepoCached(resolveRepo, cwd, force);
          if (!live()) return;
          if (top !== null) break;
        }
        // Not in a repo: the repos in its folder's subfolders, from the first
        // candidate that holds any (#2438).
        let tops: readonly string[] = top !== null ? [top] : [];
        if (top === null) {
          for (const cwd of candidates) {
            tops = await scanReposCached(api?.diff?.scanRepos, cwd, force);
            if (!live()) return;
            if (tops.length > 0) break;
          }
        }
        for (const t of tops) {
          const mainPath = await mainPathCached(list, t, plat, force);
          if (!live()) return;
          if (!mainPath) continue;
          const remoteKey = await repoKeyCached(api?.github?.repoKey, mainPath, plat, force);
          if (!live()) return;
          out.push({ workspaceId: ws.id, repoPath: t, mainPath, remoteKey, ...(top === null ? { contained: true } : {}) });
        }
      }
      if (live()) setResolved(out);
    })();
    return () => { seq.current++; };
  }, [resolutionKey, refreshKey, hidden, enabled]);

  const liveMap = useMemo(() => {
    const m: Live = {};
    for (const row of liveRows) {
      const [id, name, pr] = row.split('\u0001');
      m[id] = { name, pr: pr ? (JSON.parse(pr) as PrStatus) : null };
    }
    return m;
  }, [liveRows]);

  return useMemo(
    () => (resolved === null ? null : groupWorkspacesByRepo(resolved, liveMap, activeWorkspaceId, hostPlatform())),
    [resolved, liveMap, activeWorkspaceId],
  );
}
