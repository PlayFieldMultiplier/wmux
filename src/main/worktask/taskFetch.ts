// ─── task.fetch — main fetches origin into a worker's task repository ───────
//
// The read half of task.push (taskPush.ts). A worker whose shell has no
// credentials for origin (a WSL pane on a Windows-drive repository) cannot
// fetch, so it could neither bring the default branch into its branch to
// settle a conflict nor read it fresh. Main fetches for it, in the same git
// task.push would push with (main's own, or the repository's WSL distro's),
// under the same config checks:
//
//   - WHICH repository: the git dir main recorded for the task (never one
//     found through the worktree); for a bot's task, origin must be a plain
//     https/ssh address of the bot's own repository.
//   - WHAT: the repository's default branch (the remote's HEAD, else GitHub's
//     by key, else origin/HEAD) and the task branch, each into its own
//     remote-tracking ref (refs/remotes/origin/<name>). No tag, no submodule,
//     no local branch, and the checkout is never touched: the worker merges
//     itself (`git merge origin/<default>`).
//   - HOW: every network call (each ls-remote, the fetch) runs in a clean
//     bare git dir main makes for that call (taskPush.ts openTaskGitRepo),
//     with the recorded repository's objects, so the fetched objects land
//     there; the fetch is seeded with the repository's recent commits, writes
//     no FETCH_HEAD, runs no maintenance and writes no commit-graph. Each
//     branch is then set as its remote-tracking ref in the recorded
//     repository (`update-ref --no-deref`, no reflog), after the ref's path
//     and the commit are checked. Refused when the repository config defines
//     a remote named by origin's URL (git would read the URL as that remote)
//     or a bundle URI.
//   - Never a push.

import { isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { defaultGit, openTaskGitRepo, parseLsRemoteHead, type TaskGitRepo, type TaskGitRepoInput, type TaskPushDeps, type TaskPushGit } from './taskPush';
import { originUrlRepoKey, urlNamedRemoteRefusal, workerOriginRefusal, type GitConfigEntry } from './workerGit';

export interface TaskFetchInput extends TaskGitRepoInput {
  /** The task's branch (main's record). */
  branch: string;
  /** A bot's task: the repository origin must be. Absent for a task of the
   *  operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key. */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

/** One fetched remote-tracking ref: `origin/<branch>` and its commit. */
export interface TaskFetchedRef { ref: string; sha: string }

export type TaskFetchResult =
  | { ok: true; remote: 'origin'; defaultBranch: string; fetched: TaskFetchedRef[]; missing: string[] }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'remote-refused' | 'config-refused' | 'no-default-branch' | 'git-failed'; error: string };

/** `ls-remote --heads` output → branch name → commit. Pure. */
export function parseLsRemoteHeads(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(\S+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Why main will not fetch with this repository config, beyond the push's
 *  checks: a remote whose name is origin's URL (git would take the URL for
 *  that remote, with its own URL and refspecs), or a bundle URI (fetched
 *  from wherever it names). Only the repository's own scopes count. Pure. */
export function taskFetchConfigRefusal(entries: readonly GitConfigEntry[], url: string): string | null {
  const named = urlNamedRemoteRefusal(entries, url);
  if (named) return named;
  const own = entries.filter((e) => e.scope === 'local' || e.scope === 'worktree');
  const hit = own.find((e) => /^(?:fetch|transfer)\.bundleuri$/.test(e.key) || e.key.startsWith('bundle.'));
  return hit ? `the repository's git config sets ${hit.key}, which main does not fetch with` : null;
}

/** The git argv of main's fetch: each branch into main's own namespace
 *  (`<ns>/<i>`), nothing else written. Pure. */
export function taskFetchArgs(url: string, branches: readonly string[], ns: string): string[] {
  return [
    'fetch', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-write-commit-graph',
    '--', url, ...branches.map((b, i) => `+refs/heads/${b}:${ns}/${i}`),
  ];
}

type TaskRemoteFailure = Extract<TaskFetchResult, { ok: false }>;

/** Main's git on the task's recorded repository (main's own, or the
 *  repository's WSL distro's), after the push's and the fetch's config
 *  checks, and origin's URL and key. Never throws. */
async function openTaskRemote(
  input: Pick<TaskFetchInput, keyof TaskGitRepoInput | 'expectedRepoKey'>,
  git: TaskPushGit,
  deps: TaskPushDeps,
): Promise<{ ok: true; repo: TaskGitRepo; url: string; key: string | null } | TaskRemoteFailure> {
  const opened = await openTaskGitRepo(input, git, deps);
  if (!opened.ok) return opened;
  const { repo } = opened;
  const origin = workerOriginRefusal(repo.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const fetchRefusal = taskFetchConfigRefusal(repo.entries, origin.url);
  if (fetchRefusal) return { ok: false, reason: 'config-refused', error: fetchRefusal };
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  return { ok: true, repo, url: origin.url, key };
}

export type TaskRemoteHeadResult = { ok: true; sha: string | null } | TaskRemoteFailure;

/**
 * The commit the task branch is at on origin itself (`ls-remote`, nothing
 * written), read in the git task.push pushes with and under the same checks:
 * null when origin has no such branch. The task's repository and branch
 * come from main's record; for a bot's task origin must be its repository.
 * Never throws.
 */
export async function readTaskRemoteHead(
  input: Pick<TaskFetchInput, keyof TaskGitRepoInput | 'branch' | 'expectedRepoKey'>,
  git: TaskPushGit = defaultGit,
  deps: TaskPushDeps = {},
): Promise<TaskRemoteHeadResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be read as itself' };
  const remote = await openTaskRemote(input, git, deps);
  if (!remote.ok) return remote;
  const heads = await remote.repo.inClean(remote.url, {}, (run) => run(['ls-remote', '--heads', '--', remote.url, `refs/heads/${input.branch}`]));
  if (!heads.ok) return { ok: false, reason: 'git-failed', error: heads.error };
  if (heads.value.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.value.stderr.trim().slice(0, 500)}` };
  return { ok: true, sha: parseLsRemoteHeads(heads.value.stdout).get(input.branch) ?? null };
}

/** Fetch the default branch and the task branch. Never throws. */
export async function fetchTaskRefs(input: TaskFetchInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskFetchResult> {
  if (!isDenyableBranchName(input.branch)) return { ok: false, reason: 'branch-refused', error: 'the task branch name cannot be fetched as itself' };
  const opened = await openTaskRemote(input, git, deps);
  if (!opened.ok) return opened;
  const { repo, key, url } = opened;
  const lsRemote = async (args: string[]) => {
    const r = await repo.inClean(url, {}, (run) => run(['ls-remote', ...args]));
    return r.ok ? r.value : { code: 1, stdout: '', stderr: r.error };
  };
  // The default branch: the remote's own HEAD, else GitHub's by key, else
  // origin/HEAD.
  const remote = await lsRemote(['--symref', '--', url, 'HEAD']);
  let defaultBranch = remote.code === 0 ? parseLsRemoteHead(remote.stdout) : null;
  if (!defaultBranch && key && input.repoDefaultBranch) defaultBranch = await input.repoDefaultBranch(key).catch(() => null);
  if (!defaultBranch) {
    const ref = await repo.local(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = ref.code === 0 ? ref.stdout.trim() : '';
    if (name.startsWith('refs/remotes/origin/')) defaultBranch = name.slice('refs/remotes/origin/'.length);
  }
  if (!defaultBranch || !isDenyableBranchName(defaultBranch)) {
    return { ok: false, reason: 'no-default-branch', error: 'origin\'s default branch could not be read' };
  }
  // Only branches the remote has: a task branch not pushed yet is reported
  // missing, not an error.
  const wanted = [...new Set([defaultBranch, input.branch])];
  const heads = await lsRemote(['--heads', '--', url, ...wanted.map((b) => `refs/heads/${b}`)]);
  if (heads.code !== 0) return { ok: false, reason: 'git-failed', error: `git ls-remote failed: ${heads.stderr.trim().slice(0, 500)}` };
  const there = parseLsRemoteHeads(heads.stdout);
  if (!there.has(defaultBranch)) return { ok: false, reason: 'no-default-branch', error: `origin has no branch ${defaultBranch}` };
  const present = wanted.filter((b) => there.has(b));
  // Each remote-tracking ref's path is checked before anything is fetched.
  for (const b of present) {
    const refused = await repo.refRefusal(`refs/remotes/origin/${b}`);
    if (refused) return { ok: false, reason: 'config-refused', error: `main will not write refs/remotes/origin/${b}: ${refused}` };
  }
  const ns = 'refs/wmux/fetch';
  const res = await repo.inClean(url, { seed: true }, async (run): Promise<{ error: string } | { shas: string[] }> => {
    const f = await run(taskFetchArgs(url, present, ns));
    if (f.code !== 0) return { error: `${f.stdout}\n${f.stderr}`.trim().slice(0, 2000) || `git fetch exited ${f.code}` };
    const shas: string[] = [];
    for (const i of present.keys()) {
      const sha = await run(['rev-parse', '--verify', '--quiet', `${ns}/${i}^{commit}`]);
      shas.push(sha.code === 0 ? sha.stdout.trim() : '');
    }
    return { shas };
  });
  if (!res.ok) return { ok: false, reason: 'git-failed', error: res.error };
  if ('error' in res.value) return { ok: false, reason: 'git-failed', error: res.value.error };
  const { shas } = res.value;
  const fetched: TaskFetchedRef[] = [];
  for (const [i, b] of present.entries()) {
    const sha = shas[i] ?? '';
    const set = sha ? await repo.writeRef(`refs/remotes/origin/${b}`, sha) : null;
    if (!set || !set.ok) {
      return { ok: false, reason: 'git-failed', error: `origin/${b} could not be set after the fetch${set ? `: ${set.error}` : ''}` };
    }
    fetched.push({ ref: `origin/${b}`, sha });
  }
  return { ok: true, remote: 'origin', defaultBranch, fetched, missing: wanted.filter((b) => !there.has(b)).map((b) => `origin/${b}`) };
}
