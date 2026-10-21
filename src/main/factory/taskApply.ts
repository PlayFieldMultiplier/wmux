// ─── Apply to my checkout — a bot task's changes into the owner's folder ───
//
// A bot's dev worker commits in its own worktree, on its task branch; the
// owner's checkout (the bot's repository folder, its profile's `repoPath`)
// never sees it unless the owner merges or checks the files out by hand. The
// owner's Apply (FACTORY_TASK_APPLY, main window only — a bot or a worker
// cannot reach it) applies the task's changes to that checkout, as unstaged
// changes the owner reviews with git like any other:
//
//   - which task, base and head: main's records only. The ledger row (a bot
//     task that reported or completed, with the base commit main recorded at
//     dispatch), the task branch from main's mission record, read in the
//     checkout's refs, and it must descend from that base. The wire carries
//     only the task id.
//   - which checkout: the bot's repository folder, and only when it is the
//     top of a checkout of the very repository the task's worktree was made
//     in (the common git dir main recorded at dispatch).
//   - what is written: the task's patch (plumbing `git diff-tree -p
//     --binary base head`, so no diff setting of the owner's reshapes it),
//     applied to the working tree with `git apply` — never whole files, so
//     what the checkout changed since the task started (a pull) is kept
//     where the patch does not touch it, and a patch that no longer applies
//     is refused (`diverged`), nothing written. A checkout that already has
//     the patch says so. The index, HEAD and the branch are never touched.
//   - refused: a path with uncommitted (or untracked, or ignored) changes
//     in the checkout — listed, with a file standing where a new file's
//     folder goes — a merge, rebase, cherry-pick or revert in progress, a
//     submodule change, a repository config that makes a read run a program
//     (workerGit.ts), and more than TASK_APPLY_MAX_FILES files.
//   - content filters: a worker can write the shared repository's config
//     and `info/attributes` between any check and the write. So `git apply`
//     runs against a private, empty git dir of main's (with the checkout as
//     its work tree), no system or global config, and only the owner's line
//     ending settings (`core.autocrlf`, `core.eol`, `core.safecrlf`,
//     `core.attributesFile`) passed in: no filter driver is defined there, so
//     none can run. The repository's `info/attributes` is copied in for its
//     line endings (attributes run nothing without a driver). A touched path
//     the checkout gives a filter (Git LFS) is refused (`filtered`): what it
//     holds is not the file itself; so is a task that changes a
//     `.gitattributes`.
//   - that private git dir lives under main's own folder (`<wmux>/factory`,
//     0700), never the shared temp folder a sandboxed worker can write, and
//     the patch reaches git apply on stdin, never as a file.
//
// git runs with a fixed argv, no shell, its git dir and work tree named
// explicitly (a `core.worktree` in the shared config cannot move the
// writes), no fsmonitor, hooks from an empty folder, and literal pathspecs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import type { FactoryTaskApplyRefusal, FactoryTaskApplyResult } from '../../shared/botTask';
import { isPlainTaskBranchName } from '../../shared/taskGitRelay';
import { getExecEnv } from '../../shared/execEnv';
import { defaultGit, taskGitDirTarget, TASK_PUSH_TIMEOUT_MS, type TaskPushGit } from '../worktask/taskPush';
import { recordedTaskGitCommonDir } from '../worktask/taskGitCommonDir';
import { workerGitEnv, workerGitPreflight, workerGitSafeArgs, type GitConfigEntry } from '../worktask/workerGit';

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
  /** Main's own folder for an Apply's private git dir
   *  (`<wmux>/factory/apply`), never the shared temp folder. */
  scratchDir: string;
  /** Test seam (default: taskPush's git, no shell). */
  git?: TaskPushGit;
  /** Test seam: git with raw output and `input` on stdin (the patch's
   *  making and its applies). */
  gitRaw?: TaskApplyRawGit;
  platform?: NodeJS.Platform;
}

/** Runs git with `env` added and `input` on stdin; resolves with the exit
 *  code, raw stdout and stderr, never throws. */
export type TaskApplyRawGit = (args: string[], cwd: string, env: Record<string, string>, input?: Buffer) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

/** The most a patch may be. */
const PATCH_MAX_BYTES = 256 * 1024 * 1024;

/** Main's git, as taskPush's (no shell, a clean env), with raw output and
 *  stdin. */
export const defaultRawGit: TaskApplyRawGit = (args, cwd, extra, input) => new Promise((resolve) => {
  const out: Buffer[] = [];
  let size = 0;
  let err = '';
  let over = false;
  const child = spawn('git', args, { cwd, env: { ...workerGitEnv(getExecEnv()), GIT_TERMINAL_PROMPT: '0', ...extra }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), TASK_PUSH_TIMEOUT_MS);
  child.stdout.on('data', (d: Buffer) => {
    size += d.length;
    if (size > PATCH_MAX_BYTES) {
      over = true;
      child.kill();
      return;
    }
    out.push(d);
  });
  child.stderr.on('data', (d: Buffer) => {
    if (err.length < 64 * 1024) err += d.toString('utf8');
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    resolve({ code: 1, stdout: Buffer.alloc(0), stderr: String(e) });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve(over ? { code: 1, stdout: Buffer.alloc(0), stderr: 'the patch is too large' } : { code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input ?? Buffer.alloc(0));
});

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

/** `git check-attr -z filter` output → the paths it gives a filter driver
 *  (any value but unspecified, unset or set). Pure. */
export function filteredPaths(stdout: string): string[] {
  const parts = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const value = parts[i + 2];
    if (parts[i + 1] === 'filter' && value && !['unspecified', 'unset', 'set'].includes(value)) out.push(parts[i]);
  }
  return out;
}

/** The owner's line ending settings, as `-c` options for an apply that
 *  reads no repository config of its own (the last value of each key across
 *  the scopes, as git reads it). Pure. */
export function lineEndingArgs(entries: readonly GitConfigEntry[]): string[] {
  const out: string[] = [];
  for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf']) {
    const hits = entries.filter((e) => e.key === key);
    if (hits.length > 0) out.push('-c', `${key}=${hits[hits.length - 1].value}`);
  }
  // The owner's own attributes file (system or global), never one the
  // repository's config names.
  const attrs = entries.filter((e) => e.key === 'core.attributesfile' && (e.scope === 'system' || e.scope === 'global'));
  if (attrs.length > 0) out.push('-c', `core.attributesFile=${attrs[attrs.length - 1].value}`);
  return out;
}

/** The repository's object format, from its own config only (a sha256
 *  repository says so in `extensions.objectformat`). Pure. */
export function repoObjectFormat(entries: readonly GitConfigEntry[]): string {
  const own = entries.filter((e) => (e.scope === 'local' || e.scope === 'worktree') && e.key === 'extensions.objectformat');
  return own.length > 0 ? own[own.length - 1].value.toLowerCase() : 'sha1';
}

/** Whether the checkout already carries each mode change of the task (a
 *  reverse check of a patch passes whatever the modes are). */
function modesApplied(top: string, changes: readonly RawChange[]): boolean {
  for (const c of changes) {
    if (c.status !== 'M' && c.status !== 'T') continue;
    if (c.srcMode === c.dstMode) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(top, c.path));
    } catch {
      return false;
    }
    const mode = st.isSymbolicLink() ? '120000' : (st.mode & 0o111) !== 0 ? '100755' : '100644';
    if (mode !== c.dstMode) return false;
  }
  return true;
}

/** A `git apply` failure that means the checkout no longer matches the
 *  patch. Pure. */
export function isDivergedApply(stderr: string): boolean {
  return /patch does not apply|already exists in working directory|does not exist|No such file or directory/.test(stderr);
}

/** `git init` of main's private git dir for the apply: the repository's
 *  object format named only when it is not the default, since
 *  `--object-format` needs git 2.29. Pure. */
export function privateGitInitArgs(objectFormat: string, dir: string): string[] {
  return ['init', '-q', '--bare', '--template=', ...(objectFormat === 'sha1' ? [] : [`--object-format=${objectFormat}`]), dir];
}

/** The folders a new path needs that the checkout has as something else (a
 *  file or a link where `notes/` goes for `notes/todo.md`). */
function blockedParents(top: string, created: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of created) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(top, parent));
      } catch {
        break;
      }
      if (!st.isDirectory()) {
        out.add(parent);
        break;
      }
    }
  }
  return [...out];
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

/** A small regular file's bytes (no link), or null. */
function readRegularFile(p: string, max = 1024 * 1024): Buffer | null {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(p);
  } catch {
    return null;
  }
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

  // Plumbing: no diff setting of the owner's (renames, prefixes, relative
  // paths) changes what it reports.
  const diff = await run(['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', base, head]);
  if (diff.code !== 0) return refuse('git_failed', `git diff-tree failed: ${diff.stderr.trim().slice(0, 300)}`);
  const changes = parseRawDiff(diff.stdout);
  if (changes.length === 0) return refuse('no_changes', 'The task changed no files.');
  if (changes.length > TASK_APPLY_MAX_FILES) return refuse('too_many', `The task changed ${changes.length} files, more than Apply writes (${TASK_APPLY_MAX_FILES}); merge its branch with git.`);
  const sub = changes.find((c) => c.srcMode === '160000' || c.dstMode === '160000');
  if (sub) return refuse('submodule', `The task changes the submodule ${sub.path}; merge its branch with git.`);
  const touched = changes.map((c) => c.path);
  const created = changes.filter((c) => c.status === 'A').map((c) => c.path);

  // A path the checkout runs through a content filter (Git LFS) holds
  // something other than the file, and a changed .gitattributes changes
  // how every other path is written: neither is applied here.
  const filtered: string[] = touched.filter((p) => path.posix.basename(p) === '.gitattributes');
  for (const batch of chunks(touched)) {
    const ca = await run(['check-attr', '-z', 'filter', '--', ...batch]);
    if (ca.code !== 0) return refuse('git_failed', `git check-attr failed: ${ca.stderr.trim().slice(0, 300)}`);
    for (const p of filteredPaths(ca.stdout)) if (!filtered.includes(p)) filtered.push(p);
  }
  if (filtered.length > 0) return refuse('filtered', 'The task changes files your checkout runs through a content filter (such as Git LFS), or its attributes; merge its branch with git.', filtered);

  const objectFormat = repoObjectFormat(pre.entries);
  const raw = ports.gitRaw ?? defaultRawGit;
  // The task's patch, by plumbing, kept in memory.
  const made = await raw(['--git-dir=' + gitDir, `--work-tree=${top}`, ...safe, 'diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', base, head], top, {});
  if (made.code !== 0) return refuse('git_failed', `git diff-tree failed: ${made.stderr.trim().slice(0, 300)}`);
  const patch = made.stdout;
  // Main's own folder, not the shared temp folder.
  fs.mkdirSync(ports.scratchDir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(ports.scratchDir, 'apply-'));
  try {
    fs.chmodSync(tmp, 0o700);
    // git apply against main's own empty git dir: none of the repository's
    // config, no system or global config; the repository's info/attributes
    // copied in for its line endings (no driver exists here to run).
    const privateDir = path.join(tmp, 'git');
    const emptyConfig = path.join(tmp, 'empty-config');
    fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
    const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_DEFAULT_HASH: objectFormat, LC_ALL: 'C' };
    const init = await git(privateGitInitArgs(objectFormat, privateDir), tmp, env);
    if (init.code !== 0) return refuse('git_failed', `git init failed: ${init.stderr.trim().slice(0, 300)}`);
    const attributes = readRegularFile(path.join(common, 'info', 'attributes'));
    if (attributes !== null) {
      fs.mkdirSync(path.join(privateDir, 'info'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(privateDir, 'info', 'attributes'), attributes, { mode: 0o600 });
    }
    const eol = lineEndingArgs(pre.entries);
    const apply = (extra: string[]) => raw([`--git-dir=${privateDir}`, `--work-tree=${top}`, ...safe, ...eol, 'apply', '--whitespace=nowarn', ...extra], top, env, patch);
    const said = (r: { stderr: string }) => r.stderr.split(tmp).join('').trim().slice(0, 300);

    // Already in the checkout (a second Apply, or the task merged and
    // pulled): say so before anything else. A reverse check passes
    // whatever the modes are, so a mode change is read from the files.
    if ((await apply(['--check', '--reverse'])).code === 0 && modesApplied(top, changes)) {
      return refuse('no_changes', 'Your checkout already has the task\'s changes.');
    }

    // Anything uncommitted at those paths stops it (untracked and ignored
    // too), and so does an untracked file where a new file's folder goes.
    const dirty: string[] = [];
    for (const batch of chunks([...touched, ...blockedParents(top, created)])) {
      const st = await run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignored=matching', '--', ...batch]);
      if (st.code !== 0) return refuse('git_failed', `git status failed: ${st.stderr.trim().slice(0, 300)}`);
      for (const p of parseStatusPaths(st.stdout)) if (touched.some((c) => touches(p, c)) && !dirty.includes(p)) dirty.push(p);
    }
    if (dirty.length > 0) return refuse('dirty', `Your checkout has uncommitted changes in ${dirty.length === 1 ? 'a file' : 'files'} the task changed.`, dirty);

    const check = await apply(['--check']);
    if (check.code !== 0) {
      if (isDivergedApply(check.stderr)) return refuse('diverged', 'Your checkout changed these files since the task started, so its changes no longer apply cleanly. Merge the task branch with git instead.');
      return refuse('git_failed', `git apply failed: ${said(check)}`);
    }
    const r = await apply([]);
    if (r.code !== 0) return refuse('git_failed', `git apply failed: ${said(r)}`);
  } finally {
    // A cleanup that fails leaves a folder under main's own; it never turns
    // an apply that landed into an error.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
  return {
    ok: true,
    changed: changes.filter((c) => c.status !== 'A' && c.status !== 'D').map((c) => c.path),
    created,
    removed: changes.filter((c) => c.status === 'D').map((c) => c.path),
  };
}
