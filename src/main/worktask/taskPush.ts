// ─── task.push — main pushes a worker's own task branch ─────────────────────
//
// A bot's fan-out worker may not run `git push` itself (its deny rules refuse
// every form, shared/botWorkerGuard.ts). Its branch reaches the remote here,
// from main, with a fixed shape the worker cannot change:
//
//   - WHICH branch: the task's own branch, from main's task record (the
//     worker's verified pane → its task workspace → the open ledger row →
//     the WorkTask main created). Never a name from the wire.
//   - WHERE: origin's URL, read from the repository config right before the
//     push and pushed to as a URL (not through the remote's name). Refused
//     when origin sets anything but its URL and fetch refspec, when any URL
//     rewrite or a program-running key is set (worktask/workerGit.ts), and —
//     for a bot's task — when the URL is not a plain https/ssh address of the
//     bot's own repository. A task of the operator's goes to the operator's
//     own origin.
//   - HOW: fast-forward only (no force, no `+`), the branch alone (no tags
//     follow it, no submodule is pushed), never onto a default branch
//     (main/master, every default branch main recorded, and the repository's
//     own), never for a task on a detached checkout (the verify preset grades
//     a commit; it has no branch to publish).
//   - main's git runs with no fsmonitor and the worktree's own hooks do not
//     run (`core.hooksPath` pointed at an empty folder, `--no-verify`).
//
// Any fan-out worker may call it; for a bot's worker it is the only way to
// publish. Afterwards main sets the branch's upstream to origin, so
// `gh pr create` finds the pushed branch.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import { originUrlRepoKey, workerGitPreflight, workerGitSafeArgs, workerOriginRefusal } from './workerGit';

const execFileP = promisify(execFile);

export const TASK_PUSH_TIMEOUT_MS = 120_000;

/** Runs git in `cwd`; resolves with the exit code and output, never throws. */
export type TaskPushGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface TaskPushInput {
  /** The task's worktree (main's record). */
  worktreePath: string;
  /** The task's branch (main's record). */
  branch: string;
  /** Default branches main recorded for this instance (main/master are
   *  always added). */
  defaultBranches: readonly string[];
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** A bot's task: the repository the push must land in (`host/owner/repo`
   *  or `owner/repo`). Absent for a task of the operator's. */
  expectedRepoKey?: string;
  /** The repository's own default branch, read by its key (never from the
   *  worktree). */
  repoDefaultBranch?: (repoKey: string) => Promise<string | null>;
}

export type TaskPushResult =
  | { ok: true; branch: string; remote: 'origin'; head: string; output: string }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'remote-refused' | 'config-refused' | 'rejected' | 'git-failed'; error: string };

async function defaultGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...getExecEnv(), GIT_TERMINAL_PROMPT: '0' };
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, env, timeout: TASK_PUSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : (e.message ?? String(err)),
    };
  }
}

/** Why main will not push this branch, or null. Pure. */
export function taskPushBranchRefusal(branch: string, defaultBranches: readonly string[]): string | null {
  if (!isDenyableBranchName(branch)) return 'the task branch name cannot be pushed as itself';
  const defaults = new Set([...BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, ...defaultBranches]);
  if (defaults.has(branch)) return `the task branch ${branch} is a default branch; main never pushes onto one`;
  return null;
}

/** The git argv of main's push (after the safe `-c` options). Pure. */
export function taskPushArgs(branch: string, url: string): string[] {
  return ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', url, `HEAD:refs/heads/${branch}`];
}

/** Push the task branch. Never throws. */
export async function pushTaskBranch(input: TaskPushInput, git: TaskPushGit = defaultGit): Promise<TaskPushResult> {
  const branchRefusal = taskPushBranchRefusal(input.branch, input.defaultBranches);
  if (branchRefusal) return { ok: false, reason: 'branch-refused', error: branchRefusal };
  const safe = workerGitSafeArgs(path.resolve(input.noHooksDir));
  const run = (args: string[]) => git([...safe, ...args], input.worktreePath);
  const pre = await workerGitPreflight(run);
  if (!pre.ok) return { ok: false, reason: 'config-refused', error: pre.error };
  const origin = workerOriginRefusal(pre.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  // The repository's own default branch: GitHub's by the key, else origin/HEAD.
  let own = key && input.repoDefaultBranch ? await input.repoDefaultBranch(key).catch(() => null) : null;
  if (!own) {
    const ref = await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = ref.code === 0 ? ref.stdout.trim() : '';
    own = name.startsWith('refs/remotes/origin/') ? name.slice('refs/remotes/origin/'.length) : null;
  }
  if (own) {
    const refusal = taskPushBranchRefusal(input.branch, [...input.defaultBranches, own]);
    if (refusal) return { ok: false, reason: 'branch-refused', error: refusal };
  }
  const head = await run(['rev-parse', 'HEAD']);
  if (head.code !== 0) return { ok: false, reason: 'git-failed', error: `git rev-parse HEAD failed: ${head.stderr.trim().slice(0, 500)}` };
  const sha = head.stdout.trim();
  const res = await run(taskPushArgs(input.branch, origin.url));
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000);
  if (res.code !== 0) {
    // --porcelain marks a refused ref with `!` (non-fast-forward, remote hook).
    const rejected = /^!\t/m.test(res.stdout);
    return { ok: false, reason: rejected ? 'rejected' : 'git-failed', error: output || `git push exited ${res.code}` };
  }
  // The upstream, as `--set-upstream origin` would set it.
  await run(['update-ref', `refs/remotes/origin/${input.branch}`, sha]);
  await run(['config', `branch.${input.branch}.remote`, 'origin']);
  await run(['config', `branch.${input.branch}.merge`, `refs/heads/${input.branch}`]);
  return { ok: true, branch: input.branch, remote: 'origin', head: sha, output };
}
