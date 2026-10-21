// ─── Apply to my checkout — a bot task's changes into the owner's folder ───
//
// A bot's dev worker commits in its own worktree, on its task branch; the
// owner's checkout (the bot's repository folder, its profile's `repoPath`)
// never sees it unless the owner merges or checks the files out by hand. The
// owner's Apply (FACTORY_TASK_APPLY, main window only — a bot or a worker
// cannot reach it) writes the files the task changed into that checkout, as
// unstaged changes the owner reviews with git like any other:
//
//   - which task, base and head: main's records only. The ledger row (a bot
//     task that reported or completed, with the base commit main recorded at
//     dispatch), the task branch from main's mission record, read in the
//     checkout's refs, and it must descend from that base. The wire carries
//     only the task id.
//   - which checkout: the bot's repository folder, and only when it is the
//     top of a checkout of the very repository the task's worktree was made
//     in (the common git dir main recorded at dispatch).
//   - what is written: `git diff --raw base head` names the paths; `git
//     restore --source=<head> --worktree` writes them and removes the ones
//     the task deleted. The index, HEAD and the branch are never touched.
//   - refused: a path with uncommitted (or untracked, or ignored) changes
//     in the checkout — listed — a merge, rebase, cherry-pick or revert in
//     progress, a submodule change, a repository config that makes a read
//     run a program (workerGit.ts), and more than TASK_APPLY_MAX_FILES files.
//
// git runs with a fixed argv, no shell, its git dir and work tree named
// explicitly (a `core.worktree` in the shared config cannot move the
// writes), no fsmonitor, hooks from an empty folder, and literal pathspecs.

import fs from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import type { FactoryTaskApplyRefusal, FactoryTaskApplyResult } from '../../shared/botTask';
import { isPlainTaskBranchName } from '../../shared/taskGitRelay';
import { defaultGit, taskGitDirTarget, type TaskPushGit } from '../worktask/taskPush';
import { recordedTaskGitCommonDir } from '../worktask/taskGitCommonDir';
import { workerGitPreflight, workerGitSafeArgs } from '../worktask/workerGit';

/** The most files one Apply writes. */
export const TASK_APPLY_MAX_FILES = 1000;

/** A bot task's ledger id. */
const TASK_ID_RE = /^wtask-[A-Za-z0-9_-]{1,80}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Files in a git dir that say a merge, rebase, cherry-pick or revert is under way. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

export interface TaskApplyPorts {
  /** The task's ledger row, or null. */
  row: (taskId: string) => LedgerEntry | null;
  /** A bot's repository folder (its profile). */
  botRepoPath: (botId: string) => string | undefined;
  /** The task's branch, from main's mission record; null when unknown. */
  taskBranch: (entry: LedgerEntry) => Promise<string | null>;
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** Test seam (default: taskPush's git, no shell). */
  git?: TaskPushGit;
  platform?: NodeJS.Platform;
}

let shared: TaskApplyPorts | null = null;
export function setTaskApplyPorts(p: TaskApplyPorts | null): void {
  shared = p;
}
export function getTaskApplyPorts(): TaskApplyPorts | null {
  return shared;
}

/** The checkouts an Apply is writing to now. */
const inFlight = new Set<string>();

function refuse(code: FactoryTaskApplyRefusal, message: string, paths?: string[]): FactoryTaskApplyResult {
  return { ok: false, code, message, ...(paths ? { paths } : {}) };
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** One `git diff --raw -z` entry. */
export interface RawChange { status: string; srcMode: string; dstMode: string; path: string }

/** `git diff --raw -z --no-renames` output → its entries. Pure. */
export function parseRawDiff(stdout: string): RawChange[] {
  const parts = stdout.split('\0');
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!m) break;
    out.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: parts[i + 1] });
  }
  return out;
}

/** `git status --porcelain=v1 -z --no-renames` output → its paths. Pure. */
export function parseStatusPaths(stdout: string): string[] {
  return stdout.split('\0').filter((r) => r.length > 3).map((r) => r.slice(3));
}

/** Whether a dirty path in the checkout touches a path the task changed:
 *  the same path, or one inside the other (a folder). Pure. */
function touches(dirty: string, changed: string): boolean {
  const d = dirty.replace(/\/$/, '');
  return d === changed || changed.startsWith(`${d}/`) || d.startsWith(`${changed}/`);
}

/** Paths in batches that keep one command line short (Windows caps it). */
function chunks(paths: readonly string[], maxChars = 8000, maxCount = 200): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length > 0 && (len + p.length + 1 > maxChars || cur.length >= maxCount)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 1;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Whether anything is at `p` (a dangling link counts). */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The owner's Apply: the task's changes written into the bot's repository
 *  folder, unstaged. Never throws. */
export async function applyTaskToCheckout(ports: TaskApplyPorts, taskId: string): Promise<FactoryTaskApplyResult> {
  if (!TASK_ID_RE.test(taskId)) return refuse('invalid_argument', 'taskId must be a task id');
  const entry = ports.row(taskId);
  const botId = entry?.dispatch?.origin.kind === 'bot' ? entry.dispatch.origin.botId : undefined;
  if (!entry || !botId) return refuse('unknown_task', 'There is no bot task with that id.');
  if (entry.status !== 'review_requested' && entry.status !== 'completed') {
    return refuse('not_ready', 'The task has not reported its work yet.');
  }
  const base = entry.dispatch?.checkout ? undefined : entry.dispatch?.baseOid;
  if (!base || !SHA_RE.test(base)) return refuse('no_base', 'wmux recorded no commit the task started from, so its changes cannot be told apart.');
  const repoPath = ports.botRepoPath(botId);
  if (!repoPath || !path.isAbsolute(repoPath)) return refuse('no_repo', 'The bot has no repository folder.');
  const platform = ports.platform ?? process.platform;
  const recorded = await recordedTaskGitCommonDir(entry.dispatch, ports.botRepoPath);
  if (!recorded) return refuse('other_repo', 'wmux recorded no repository for the task.');
  if (taskGitDirTarget(recorded, platform).kind !== 'host' || taskGitDirTarget(repoPath, platform).kind !== 'host') {
    return refuse('other_repo', 'Apply does not reach a repository inside WSL yet; merge the task branch there with git.');
  }
  const top = realOrNull(repoPath);
  if (!top) return refuse('no_repo', `The bot's repository folder ${repoPath} is not there.`);
  if (inFlight.has(top)) return refuse('busy', 'Another Apply is writing to this checkout.');
  inFlight.add(top);
  try {
    return await apply(ports, entry, base, top, recorded, platform);
  } catch (err) {
    return refuse('git_failed', String(err instanceof Error ? err.message : err));
  } finally {
    inFlight.delete(top);
  }
}

async function apply(ports: TaskApplyPorts, entry: LedgerEntry, base: string, top: string, recorded: string, platform: NodeJS.Platform): Promise<FactoryTaskApplyResult> {
  const git = ports.git ?? defaultGit;
  const safe = [...workerGitSafeArgs(path.resolve(ports.noHooksDir)), '-c', 'submodule.recurse=false', '--literal-pathspecs'];
  const plain = (args: string[]) => git(args, top);
  // The checkout's own git dir and its top, as git reads them from the folder.
  const gitDirOut = await plain(['rev-parse', '--absolute-git-dir']);
  const gitDir = gitDirOut.code === 0 ? realOrNull(gitDirOut.stdout.trim()) : null;
  const topOut = await plain(['rev-parse', '--show-toplevel']);
  const shown = topOut.code === 0 ? realOrNull(topOut.stdout.trim()) : null;
  if (!gitDir || !shown) return refuse('no_repo', `The bot's repository folder ${top} is not a git checkout.`);
  if (!samePath(shown, top, platform)) return refuse('no_repo', `The bot's repository folder ${top} is not the top of its checkout.`);
  const commonOut = await plain(['rev-parse', '--git-common-dir']);
  const common = commonOut.code === 0 ? realOrNull(path.resolve(top, commonOut.stdout.trim())) : null;
  const recordedReal = realOrNull(recorded) ?? recorded;
  if (!common || !samePath(common, recordedReal, platform)) {
    return refuse('other_repo', `The bot's repository folder ${top} is not the repository the task worked in.`);
  }
  // Every later call names the git dir and the work tree itself.
  const run = (args: string[]) => git([`--git-dir=${gitDir}`, `--work-tree=${top}`, ...safe, ...args], top);
  const pre = await workerGitPreflight(run, 'read');
  if (!pre.ok) return refuse('config_refused', pre.error);
  const busy = IN_PROGRESS.find((f) => present(path.join(gitDir, f)));
  if (busy) return refuse('merge_in_progress', 'Your checkout is in the middle of a merge, rebase, cherry-pick or revert. Finish or abort it first.');

  // The head: the task branch main recorded, in the checkout's refs; it
  // must hold work past the base, and descend from it.
  const branch = await ports.taskBranch(entry);
  if (!branch || !isPlainTaskBranchName(branch)) return refuse('no_branch', 'wmux has no record of the task\'s branch.');
  const headOut = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  const head = headOut.stdout.trim();
  if (headOut.code !== 0 || !SHA_RE.test(head)) return refuse('no_branch', `The task branch ${branch} is not in your checkout's repository.`);
  if (head === base) return refuse('no_changes', 'The task made no commits.');
  const lineage = await run(['merge-base', '--is-ancestor', base, head]);
  if (lineage.code !== 0) return refuse('foreign_head', `The task branch ${branch} does not start from the commit the task started from.`);

  const diff = await run(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', base, head]);
  if (diff.code !== 0) return refuse('git_failed', `git diff failed: ${diff.stderr.trim().slice(0, 300)}`);
  const changes = parseRawDiff(diff.stdout);
  if (changes.length === 0) return refuse('no_changes', 'The task changed no files.');
  if (changes.length > TASK_APPLY_MAX_FILES) return refuse('too_many', `The task changed ${changes.length} files, more than Apply writes (${TASK_APPLY_MAX_FILES}); merge its branch with git.`);
  const sub = changes.find((c) => c.srcMode === '160000' || c.dstMode === '160000');
  if (sub) return refuse('submodule', `The task changes the submodule ${sub.path}; merge its branch with git.`);
  const writes = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  // A path the task removed that is not in the checkout either: nothing to do.
  const removals = changes.filter((c) => c.status === 'D' && present(path.join(top, c.path))).map((c) => c.path);
  const touched = [...writes, ...removals];
  if (touched.length === 0) return refuse('no_changes', 'Your checkout already matches the task.');

  // Anything uncommitted at those paths stops it (untracked and ignored too).
  const dirty: string[] = [];
  for (const batch of chunks(touched)) {
    const st = await run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignored=matching', '--', ...batch]);
    if (st.code !== 0) return refuse('git_failed', `git status failed: ${st.stderr.trim().slice(0, 300)}`);
    for (const p of parseStatusPaths(st.stdout)) if (touched.some((c) => touches(p, c)) && !dirty.includes(p)) dirty.push(p);
  }
  if (dirty.length > 0) return refuse('dirty', `Your checkout has uncommitted changes in ${dirty.length === 1 ? 'a file' : 'files'} the task changed.`, dirty);

  // What the checkout tracks now, to tell a changed file from a new one.
  const tracked = new Set<string>();
  for (const batch of chunks(writes)) {
    const ls = await run(['ls-files', '-z', '--', ...batch]);
    if (ls.code !== 0) return refuse('git_failed', `git ls-files failed: ${ls.stderr.trim().slice(0, 300)}`);
    for (const p of ls.stdout.split('\0')) if (p) tracked.add(p);
  }
  for (const batch of chunks(touched)) {
    const r = await run(['restore', `--source=${head}`, '--worktree', '--', ...batch]);
    if (r.code !== 0) return refuse('git_failed', `git restore failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  return {
    ok: true,
    changed: writes.filter((p) => tracked.has(p)),
    created: writes.filter((p) => !tracked.has(p)),
    removed: removals,
  };
}
