// ─── task.push — main pushes a worker's own task branch ─────────────────────
//
// A bot's fan-out worker may not run `git push` itself (its deny rules refuse
// every form, shared/botWorkerGuard.ts). Its branch reaches the remote here,
// from main, with a fixed shape the worker cannot change:
//
//   - WHICH branch: the task's own branch, from main's task record (the
//     worker's verified pane → its task workspace → the open ledger row →
//     the WorkTask main created). Never a name from the wire.
//   - WHERE: `origin`, as `HEAD:refs/heads/<task branch>`.
//   - HOW: fast-forward only (no force, no `+`), the branch alone (no tags
//     follow it), never onto a default branch (main/master, every default
//     branch main recorded, and the repository's own), never for a task
//     on a detached checkout (the verify preset grades a commit; it has no
//     branch to publish).
//   - The worktree's own hooks do not run (`core.hooksPath` pointed at an empty
//     folder, `--no-verify`): main runs this, not the worker.
//
// Any fan-out worker may call it; for a bot's worker it is the only way to
// publish. The upstream is set, so `gh pr create` finds the pushed branch.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, isDenyableBranchName } from '../../shared/botWorkerGuard';

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
}

export type TaskPushResult =
  | { ok: true; branch: string; remote: 'origin'; head: string; output: string }
  | { ok: false; reason: 'branch-refused' | 'no-origin' | 'rejected' | 'git-failed'; error: string };

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

/** The git argv of main's push. Pure. */
export function taskPushArgs(branch: string, noHooksDir: string): string[] {
  return ['-c', `core.hooksPath=${noHooksDir}`, 'push', '--no-verify', '--no-follow-tags', '--porcelain', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`];
}

/** Push the task branch. Never throws. */
export async function pushTaskBranch(input: TaskPushInput, git: TaskPushGit = defaultGit): Promise<TaskPushResult> {
  const refusal = taskPushBranchRefusal(input.branch, input.defaultBranches);
  if (refusal) return { ok: false, reason: 'branch-refused', error: refusal };
  const remotes = await git(['remote'], input.worktreePath);
  if (remotes.code !== 0) return { ok: false, reason: 'git-failed', error: `git remote failed: ${remotes.stderr.trim().slice(0, 500)}` };
  if (!remotes.stdout.split('\n').map((r) => r.trim()).includes('origin')) {
    return { ok: false, reason: 'no-origin', error: 'the repository has no origin remote' };
  }
  const head = await git(['rev-parse', 'HEAD'], input.worktreePath);
  if (head.code !== 0) return { ok: false, reason: 'git-failed', error: `git rev-parse HEAD failed: ${head.stderr.trim().slice(0, 500)}` };
  const res = await git(taskPushArgs(input.branch, path.resolve(input.noHooksDir)), input.worktreePath);
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000);
  if (res.code !== 0) {
    // --porcelain marks a refused ref with `!` (non-fast-forward, remote hook).
    const rejected = /^!\t/m.test(res.stdout);
    return { ok: false, reason: rejected ? 'rejected' : 'git-failed', error: output || `git push exited ${res.code}` };
  }
  return { ok: true, branch: input.branch, remote: 'origin', head: head.stdout.trim(), output };
}
