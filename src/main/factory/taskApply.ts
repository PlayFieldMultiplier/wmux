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
//   - every read past the refs runs in that private git dir too: the
//     repository's objects borrowed through `objects/info/alternates`, its
//     index copied in. So no git main runs on the task's repository can be
//     made to fetch a missing object (no promisor remote exists there; every
//     call also sets GIT_NO_LAZY_FETCH), re-hash a file through a filter, or
//     trust a commit-graph; the shared repository is read only for its
//     config and refs. The paths the checks covered are the patch's own
//     (read back from it), so an object swapped between the two reads is
//     refused.
//
// git runs with a fixed argv, no shell, its git dir and work tree named
// explicitly (a `core.worktree` in the shared config cannot move the
// writes), no fsmonitor, hooks from an empty folder, and literal pathspecs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import type { FactoryTaskApplyRefusal, FactoryTaskApplyResult } from '../../shared/botTask';
import { isPlainTaskBranchName, taskGitEnv } from '../../shared/taskGitRelay';
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
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (over) return resolve({ code: 1, stdout: Buffer.alloc(0), stderr: 'the patch is too large' });
    resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: signal ? `${err}git was stopped (${signal})` : err });
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
export interface RawChange { status: string; srcMode: string; dstMode: string; path: string; srcOid?: string; dstOid?: string }

/** `git diff --raw -z --no-renames` output → its entries. Pure. */
export function parseRawDiff(stdout: string): RawChange[] {
  const parts = stdout.split('\0');
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
    if (!m) break;
    out.push({ srcMode: m[1], dstMode: m[2], srcOid: m[3], dstOid: m[4], status: m[5], path: parts[i + 1] });
  }
  return out;
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

/** Whether the checkout already carries each file mode of the task (a
 *  reverse check of a patch passes whatever the modes are): the executable
 *  bit only where git tracks it (`fileMode`), a link only where the checkout
 *  makes links (`symlinks`). */
export function modesApplied(top: string, changes: readonly RawChange[], opts: { fileMode: boolean; symlinks: boolean }): boolean {
  for (const c of changes) {
    if (c.status === 'D') continue;
    if (c.status === 'M' && c.srcMode === c.dstMode) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(top, c.path));
    } catch {
      return false;
    }
    const link = c.dstMode === '120000';
    if (opts.symlinks && link !== st.isSymbolicLink()) return false;
    if (opts.fileMode && !link && st.isFile() && ((st.mode & 0o111) !== 0) !== (c.dstMode === '100755')) return false;
  }
  return true;
}

/** Whether every change only flips a file's executable bit (the same
 *  content). Pure. */
export function onlyExecBitChanges(changes: readonly RawChange[]): boolean {
  const regular = (m: string) => m === '100644' || m === '100755';
  return changes.length > 0 && changes.every((c) => c.status === 'M' && c.srcMode !== c.dstMode && regular(c.srcMode) && regular(c.dstMode) && !!c.srcOid && c.srcOid === c.dstOid);
}

/** A boolean git setting as the scopes leave it (`fallback` when unset). Pure. */
function configBool(entries: readonly GitConfigEntry[], key: string, fallback: boolean): boolean {
  const hits = entries.filter((e) => e.key === key);
  if (hits.length === 0) return fallback;
  return !/^(?:false|no|off|0)$/i.test(hits[hits.length - 1].value.trim());
}

/** The paths `git apply --numstat -z` reads from a patch. Pure. */
export function patchPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean).map((r) => r.split('\t').slice(2).join('\t'));
}

/** A gitlink (submodule) anywhere in a patch's headers. Pure. */
export function patchHasGitlink(patch: Buffer): boolean {
  return /^(?:new file mode|deleted file mode|old mode|new mode) 160000$|^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/m.test(patch.toString('latin1'));
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

/** A regular file's bytes, at most `max` (no link followed, never a FIFO
 *  or a device), or null when it is not one. */
function readRegularFile(p: string, max: number): Buffer | null {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(p, flags);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The most of a copied index. */
const INDEX_MAX_BYTES = 512 * 1024 * 1024;

/** Folders of Apply's own that a crash left (older than an hour), removed. */
function sweepScratch(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('apply-')) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.lstatSync(p).mtimeMs > 60 * 60_000) fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
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
  const noLazy = taskGitEnv();
  const safe = [...workerGitSafeArgs(path.resolve(ports.noHooksDir)), '-c', 'submodule.recurse=false', '--literal-pathspecs'];
  const plain = (args: string[]) => git(args, top, noLazy);
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
  // The shared repository is read for its config and refs only, naming its
  // git dir and work tree itself.
  const run = (args: string[]) => git([`--git-dir=${gitDir}`, `--work-tree=${top}`, ...safe, ...args], top, noLazy);
  const pre = await workerGitPreflight(run, 'read');
  if (!pre.ok) return refuse('config_refused', pre.error);
  const promisor = pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && (e.key === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(e.key)));
  if (promisor) return refuse('config_refused', `The repository is a partial clone (${promisor.key}); merge the task branch with git.`);
  const busy = IN_PROGRESS.find((f) => present(path.join(gitDir, f)));
  if (busy) return refuse('merge_in_progress', 'Your checkout is in the middle of a merge, rebase, cherry-pick or revert. Finish or abort it first.');

  // The head: the task branch main recorded, read as a ref (no object).
  const branch = await ports.taskBranch(entry);
  if (!branch || !isPlainTaskBranchName(branch)) return refuse('no_branch', 'wmux has no record of the task\'s branch.');
  const headOut = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}`]);
  const head = headOut.stdout.trim();
  if (headOut.code !== 0 || !SHA_RE.test(head)) return refuse('no_branch', `The task branch ${branch} is not in your checkout's repository.`);
  if (head === base) return refuse('no_changes', 'The task made no commits.');
  // The checkout's own HEAD, for its staged changes (none: no commit yet).
  const checkoutHeadOut = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD']);
  const checkoutHead = checkoutHeadOut.code === 0 && SHA_RE.test(checkoutHeadOut.stdout.trim()) ? checkoutHeadOut.stdout.trim() : null;

  const objectFormat = repoObjectFormat(pre.entries);
  const raw = ports.gitRaw ?? defaultRawGit;
  sweepScratch(ports.scratchDir);
  // Main's own folder, not the shared temp folder.
  fs.mkdirSync(ports.scratchDir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(ports.scratchDir, 'apply-'));
  try {
    fs.chmodSync(tmp, 0o700);
    // Main's own empty git dir: none of the repository's config, no system
    // or global config, the repository's objects borrowed (alternates), its
    // index and info/attributes copied in (attributes run nothing without a
    // driver, and none is defined here).
    const privateDir = path.join(tmp, 'git');
    const emptyConfig = path.join(tmp, 'empty-config');
    fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
    const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_DEFAULT_HASH: objectFormat, LC_ALL: 'C', ...noLazy };
    const init = await git(privateGitInitArgs(objectFormat, privateDir), tmp, env);
    if (init.code !== 0) return refuse('git_failed', `git init failed: ${init.stderr.trim().slice(0, 300)}`);
    fs.mkdirSync(path.join(privateDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(privateDir, 'objects', 'info', 'alternates'), `${path.join(common, 'objects')}\n`, { mode: 0o600 });
    const attributes = readRegularFile(path.join(common, 'info', 'attributes'), 1024 * 1024);
    if (attributes !== null) {
      fs.mkdirSync(path.join(privateDir, 'info'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(privateDir, 'info', 'attributes'), attributes, { mode: 0o600 });
    }
    if (present(path.join(gitDir, 'index'))) {
      const index = readRegularFile(path.join(gitDir, 'index'), INDEX_MAX_BYTES);
      if (index === null) return refuse('git_failed', 'Your checkout\'s index could not be read.');
      fs.writeFileSync(path.join(privateDir, 'index'), index, { mode: 0o600 });
      // Its own times kept: git judges a racily clean entry against them.
      try {
        const st = fs.lstatSync(path.join(gitDir, 'index'));
        fs.utimesSync(path.join(privateDir, 'index'), st.atime, st.mtime);
      } catch {
        return refuse('git_failed', 'Your checkout\'s index could not be read.');
      }
      // A split index names its shared part by file.
      for (const name of fs.readdirSync(gitDir).filter((n) => /^sharedindex\.[0-9a-f]+$/.test(n))) {
        const part = readRegularFile(path.join(gitDir, name), INDEX_MAX_BYTES);
        if (part !== null) fs.writeFileSync(path.join(privateDir, name), part, { mode: 0o600 });
      }
    }
    const eol = lineEndingArgs(pre.entries);
    const priv = (args: string[], input?: Buffer) => raw([`--git-dir=${privateDir}`, `--work-tree=${top}`, ...safe, '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false', ...eol, ...args], top, env, input);
    const text = async (args: string[]) => {
      const r = await priv(args);
      return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
    };
    const said = (r: { stderr: string }) => r.stderr.split(tmp).join('').trim().slice(0, 300);
    /** Whether a tracked file's content in the work tree is its index blob
     *  (a regular file, hashed with the checkout's line endings). */
    const sameAsIndex = async (p: string): Promise<boolean> => {
      const staged = await text(['ls-files', '-s', '-z', '--', p]);
      const m = /^(\d{6}) ([0-9a-f]+) 0\t/.exec(staged.stdout);
      if (staged.code !== 0 || !m || m[1] === '120000') return false;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(top, p));
      } catch {
        return false;
      }
      if (!st.isFile()) return false;
      const hashed = await text(['hash-object', `--path=${p}`, '--', path.join(top, p)]);
      return hashed.code === 0 && hashed.stdout.trim() === m[2];
    };

    // The head is a commit of the task: it descends from the base.
    const kind = await text(['cat-file', '-t', head]);
    if (kind.code !== 0 || kind.stdout.trim() !== 'commit') return refuse('no_branch', `The task branch ${branch} does not name a commit.`);
    const lineage = await text(['merge-base', '--is-ancestor', base, head]);
    if (lineage.code !== 0) return refuse('foreign_head', `The task branch ${branch} does not start from the commit the task started from.`);

    // Plumbing: no diff setting of the owner's changes what it reports.
    const diff = await text(['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', base, head]);
    if (diff.code !== 0) return refuse('git_failed', `git diff-tree failed: ${said(diff)}`);
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
    const filtered: string[] = touched.filter((p) => path.posix.basename(p).toLowerCase() === '.gitattributes');
    for (const batch of chunks(touched)) {
      const ca = await text(['check-attr', '-z', 'filter', '--', ...batch]);
      if (ca.code !== 0) return refuse('git_failed', `git check-attr failed: ${said(ca)}`);
      for (const p of filteredPaths(ca.stdout)) if (!filtered.includes(p)) filtered.push(p);
    }
    if (filtered.length > 0) return refuse('filtered', 'The task changes files your checkout runs through a content filter (such as Git LFS), or its attributes; merge its branch with git.', filtered);

    // The task's patch, by plumbing, kept in memory; the paths checked above
    // must be exactly the patch's own.
    const made = await priv(['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', base, head]);
    if (made.code !== 0) return refuse('git_failed', `git diff-tree failed: ${said(made)}`);
    const patch = made.stdout;
    const numstat = await priv(['apply', '--numstat', '-z'], patch);
    const inPatch = numstat.code === 0 ? patchPaths(numstat.stdout.toString('utf8')) : null;
    // A type change (a file made a link) is a deletion and a creation of one
    // path in a patch: the paths compare as sets.
    const patchSet = new Set(inPatch ?? []);
    if (!inPatch || patchSet.size !== new Set(touched).size || [...patchSet].some((p) => !touched.includes(p)) || patchHasGitlink(patch)) {
      return refuse('git_failed', 'The task\'s history changed while it was read; try again.');
    }
    const apply = (extra: string[]) => priv(['apply', '--whitespace=nowarn', ...extra], patch);

    // Already in the checkout (a second Apply, or the task merged and
    // pulled): say so before anything else. A reverse check passes
    // whatever the modes are, so they are read from the files.
    const modes = { fileMode: configBool(pre.entries, 'core.filemode', platform !== 'win32'), symlinks: configBool(pre.entries, 'core.symlinks', platform !== 'win32') };
    // A task that only makes files executable has nothing to write where git
    // does not track the bit (Windows' default).
    if (!modes.fileMode && onlyExecBitChanges(changes)) return refuse('no_changes', 'Nothing to write: this checkout does not track the executable bit.');
    if ((await apply(['--check', '--reverse'])).code === 0 && modesApplied(top, changes, modes)) {
      return refuse('no_changes', 'Your checkout already has the task\'s changes.');
    }

    // Anything uncommitted at those paths stops it: staged (the index
    // against HEAD), changed in the work tree (against the index), or there
    // but not tracked (untracked or ignored), and an untracked file where a
    // new file's folder goes.
    const dirty: string[] = [];
    const add = (p: string) => {
      if (!dirty.includes(p)) dirty.push(p);
    };
    const tracked = new Set<string>();
    for (const batch of chunks(touched)) {
      const staged = checkoutHead ? await text(['diff-index', '--cached', '-z', '--name-only', checkoutHead, '--', ...batch]) : await text(['ls-files', '-z', '--', ...batch]);
      if (staged.code !== 0) return refuse('git_failed', `git diff-index failed: ${said(staged)}`);
      for (const p of staged.stdout.split('\0')) if (p) add(p);
      // Stat-dirty entries are named too; each is hashed here (where no
      // filter exists, the touched paths only) and counts when its content
      // differs from the index.
      const changed = await text(['diff-files', '-z', '--name-only', '--', ...batch]);
      if (changed.code !== 0) return refuse('git_failed', `git diff-files failed: ${said(changed)}`);
      for (const p of changed.stdout.split('\0')) if (p && !(await sameAsIndex(p))) add(p);
    }
    const looked = [...touched, ...blockedParents(top, created)];
    for (const batch of chunks(looked)) {
      const ls = await text(['ls-files', '-z', '--', ...batch]);
      if (ls.code !== 0) return refuse('git_failed', `git ls-files failed: ${said(ls)}`);
      for (const p of ls.stdout.split('\0')) if (p) tracked.add(p);
    }
    for (const p of looked) if (!tracked.has(p) && present(path.join(top, p))) add(p);
    if (dirty.length > 0) return refuse('dirty', `Your checkout has uncommitted changes in ${dirty.length === 1 ? 'a file' : 'files'} the task changed.`, dirty);

    const check = await apply(['--check']);
    if (check.code !== 0) {
      if (isDivergedApply(check.stderr)) return refuse('diverged', 'Your checkout changed these files since the task started, so its changes no longer apply cleanly. Merge the task branch with git instead.');
      return refuse('git_failed', `git apply failed: ${said(check)}`);
    }
    const r = await apply([]);
    if (r.code !== 0) return refuse('git_failed', `git apply failed: ${said(r)}`);
    return {
      ok: true,
      changed: changes.filter((c) => c.status !== 'A' && c.status !== 'D').map((c) => c.path),
      created,
      removed: changes.filter((c) => c.status === 'D').map((c) => c.path),
    };
  } finally {
    // A cleanup that fails leaves a folder under main's own (swept on a
    // later Apply); it never turns an apply that landed into an error.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
}
