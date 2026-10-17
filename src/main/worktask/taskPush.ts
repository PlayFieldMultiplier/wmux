// ─── task.push — main pushes a worker's own task branch ─────────────────────
//
// A bot's fan-out worker may not run `git push` itself (its deny rules refuse
// every form, shared/botWorkerGuard.ts). Its branch reaches the remote here,
// from main, with a fixed shape the worker cannot change:
//
//   - WHICH branch: the task's own branch, from main's task record (the
//     worker's verified pane → its task workspace → the open ledger row →
//     the WorkTask main created). Never a name from the wire.
//   - WHICH repository: the git dir main recorded for the task at dispatch
//     (LedgerDispatch.gitCommonDir). Every git call that reads its config or
//     writes to it names that path (`--git-dir`); only the worktree's HEAD is
//     read through the worktree.
//   - WHERE: origin's URL, read from that repository's config and pushed to
//     as a URL (not through the remote's name). Refused when origin sets
//     anything but its URL and fetch refspec, when any URL rewrite or a
//     program-running key is set (worktask/workerGit.ts), when the config
//     defines a remote named by origin's URL (the same remote and ref checks
//     as task_fetch), and — for a bot's task — when the URL is not a plain
//     https/ssh address of the bot's own repository. A task of the operator's
//     goes to the operator's own origin.
//   - IN WHICH git dir: every network call (the push, each ls-remote) runs in
//     a clean bare git dir main makes for that call and deletes after it
//     (shared/taskGitCleanDir.ts), with the recorded repository's objects:
//     git reads the owner's system and global config there, not the task
//     repository's.
//   - HOW: fast-forward only (no force, no `+`), the branch alone (no tags
//     follow it, no submodule is pushed), never onto a default branch
//     (main/master, every default branch main recorded, and the repository's
//     own), never for a task on a detached checkout (the verify preset grades
//     a commit; it has no branch to publish).
//   - main's git runs with no fsmonitor and the worktree's own hooks do not
//     run (`core.hooksPath` pointed at an empty folder, `--no-verify`).
//   - IN WHICH git: on Windows, a task whose recorded repository lives inside
//     a WSL distro (a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…`
//     path) is pushed by that distro's own git, through `wsl.exe -d <distro>
//     --exec git` (argv only, no shell), so the distro's ssh keys and
//     credential helpers apply. Every step runs in that one git; the clean
//     dir is the distro's view of main's folder (`/mnt/<drive>/…`). A path
//     under a WSL host whose distro or path cannot be read is refused, never
//     guessed. Any other task is pushed by main's own git.
//   - The repository's own default branch is refused under every name it is
//     read by: GitHub's (by key), origin/HEAD, and the remote's own HEAD
//     (`ls-remote --symref` at the pushed URL), which needs no GitHub and no
//     ref the worker can write.
//
// Any fan-out worker may call it; for a bot's worker it is the only way to
// publish. Afterwards main sets origin/<branch> to the pushed commit (the
// path checked first, shared/taskGitCleanDir.ts guardedRefPathRefusal);
// `gh pr create --head <branch>` names the pushed branch.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { toWslPath } from '../../shared/imagePaste';
import { mergeWslEnv } from '../../shared/wsl';
import { decodeWslOutput, isValidWslDistroName } from '../../shared/wslDistro';
import { BOT_WORKER_FALLBACK_DEFAULT_BRANCHES, isDenyableBranchName } from '../../shared/botWorkerGuard';
import { normalizeRepoKey } from '../../shared/repoKey';
import {
  cleanGitConfigArgs, cleanGitEnv, cleanGitSeedPackedRefs, CLEAN_GIT_DEFAULT_PROTOCOLS, CLEAN_GIT_SEED_MAX, guardedRefPathRefusal,
  parseRawGitConfigList, parseSeedTips, transportConfigDiff, type PathKind, type RefPathPorts,
} from '../../shared/taskGitCleanDir';
import { originUrlRepoKey, urlNamedRemoteRefusal, workerGitEnv, workerGitPreflight, workerGitSafeArgs, workerOriginRefusal, type GitConfigEntry } from './workerGit';

const execFileP = promisify(execFile);

export const TASK_PUSH_TIMEOUT_MS = 120_000;

type GitOut = { code: number; stdout: string; stderr: string };

/** Runs git in `cwd` with `env` added; resolves with the exit code and
 *  output, never throws. */
export type TaskPushGit = (args: string[], cwd: string, env?: Record<string, string>) => Promise<GitOut>;

/** Where main's git finds the task's repository: main's records only. */
export interface TaskGitRepoInput {
  /** The task's worktree (main's record); only its HEAD is read there. */
  worktreePath: string;
  /** The task repository's git dir main recorded at dispatch (its common
   *  dir, resolved). */
  gitCommonDir: string;
  /** An empty folder for `core.hooksPath`. */
  noHooksDir: string;
  /** Main's folder for clean git dirs (`<wmux>/factory/git-clean`). */
  cleanRoot: string;
}

export interface TaskPushInput extends TaskGitRepoInput {
  /** The task's branch (main's record). */
  branch: string;
  /** Default branches main recorded for this instance (main/master are
   *  always added). */
  defaultBranches: readonly string[];
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

export async function defaultGit(args: string[], cwd: string, extra?: Record<string, string>): Promise<GitOut> {
  const env = { ...workerGitEnv(getExecEnv()), GIT_TERMINAL_PROMPT: '0', ...extra };
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

/** The git argv of main's push (after the safe `-c` options): the commit
 *  `sha` HEAD was resolved to, never `HEAD` itself, so what lands is what
 *  main read and records even if HEAD moves meanwhile. Pure. */
export function taskPushArgs(branch: string, url: string, sha: string): string[] {
  return ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', url, `${sha}:refs/heads/${branch}`];
}

/** Which git pushes a worktree: main's own, or a WSL distro's. */
export type TaskPushGitTarget =
  | { kind: 'host' }
  | { kind: 'wsl'; distro: string; gitDir: string }
  | { kind: 'refused'; error: string };

const WSL_GITDIR_RE = /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]([^\\/]*)(.*)$/i;

/** The git that pushes a worktree, from its `.git` file's text (null: a
 *  `.git` folder or none). Only on Windows is a gitdir under a WSL host a
 *  distro's; its Linux path must be absolute and plain. Pure. */
export function taskPushGitTarget(dotGit: string | null, platform: NodeJS.Platform = process.platform): TaskPushGitTarget {
  if (platform !== 'win32' || dotGit === null) return { kind: 'host' };
  const line = /^gitdir:[ \t]*(.*?)[ \t]*$/m.exec(dotGit.replace(/\r/g, ''));
  if (!line) return { kind: 'host' };
  return taskGitDirTarget(line[1], platform);
}

/** The git that runs on a git dir at `dir` (a path main recorded): on
 *  Windows, a path under a WSL host is that distro's. Pure. */
export function taskGitDirTarget(dir: string, platform: NodeJS.Platform = process.platform): TaskPushGitTarget {
  if (platform !== 'win32') return { kind: 'host' };
  const m = WSL_GITDIR_RE.exec(dir);
  if (!m) return { kind: 'host' };
  const distro = m[1];
  if (!isValidWslDistroName(distro)) {
    return { kind: 'refused', error: `the task's repository is inside WSL, but the distro in its gitdir (${JSON.stringify(dir.slice(0, 300))}) cannot be read` };
  }
  const gitDir = m[2].replace(/\\/g, '/');
  const segs = gitDir.split('/').slice(1);
  // eslint-disable-next-line no-control-regex
  if (!gitDir.startsWith('/') || segs.some((s) => !s || s === '.' || s === '..') || /[\x00-\x1f\x7f]/.test(gitDir)) {
    return { kind: 'refused', error: `the task's repository is inside WSL distro ${distro}, but its gitdir path (${JSON.stringify(dir.slice(0, 300))}) cannot be used` };
  }
  return { kind: 'wsl', distro, gitDir };
}

/** Runs `file` with `args`; resolves with the exit code and output, never
 *  throws. */
export type TaskPushExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<GitOut>;

async function defaultWslExec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitOut> {
  // The Linux child's bytes are UTF-8 (a NUL in `config -z` is data). wsl.exe's
  // own failure text may be UTF-16 and lands on stdout or stderr; it is read
  // from stdout only when the run failed with nothing on stderr.
  const opts = { cwd: os.homedir(), env, timeout: TASK_PUSH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'buffer' as const };
  try {
    const { stdout, stderr } = await execFileP(file, args, opts);
    return { code: 0, stdout: stdout.toString('utf8'), stderr: decodeWslOutput(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    let stderr = Buffer.isBuffer(e.stderr) && e.stderr.length > 0 ? decodeWslOutput(e.stderr).trim() : '';
    if (!stderr && Buffer.isBuffer(e.stdout) && e.stdout.length > 0) stderr = decodeWslOutput(e.stdout).trim();
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : '',
      stderr: stderr || (e.message ?? String(err)),
    };
  }
}

/** The wsl.exe argv that runs `git <args>` on a gitdir inside a distro.
 *  `--exec` runs git with no shell; `--cd /` keeps the worktree's folder out
 *  of it. Pure. */
export function wslGitArgv(distro: string, gitDir: string, args: readonly string[]): string[] {
  return ['-d', distro, '--cd', '/', '--exec', 'git', `--git-dir=${gitDir}`, ...args];
}

function wslExePath(systemRoot: string | undefined): string {
  return path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
}

/** The env of a wsl.exe run: `extra` reaches the distro only by name in
 *  WSLENV (its values are Linux paths and text, so no `/p`). */
function wslEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The same variables as main's own git leaves out, and none of git's own
  // forwarded by an existing WSLENV: the distro's git gets only main's.
  const base = workerGitEnv(getExecEnv());
  const forwarded = (base.WSLENV ?? '').split(':').filter((n) => n && !/^GIT_/i.test(n.split('/')[0])).join(':');
  const add = { GIT_TERMINAL_PROMPT: '0', ...extra };
  return { ...base, ...add, WSL_UTF8: '1', WSLENV: mergeWslEnv(forwarded, Object.keys(add)) };
}

/** A TaskPushGit that runs inside a WSL distro on its gitdir (the `cwd` it is
 *  handed — a Windows path — is not used). */
export function wslTaskPushGit(distro: string, gitDir: string, exec: TaskPushExec = defaultWslExec, systemRoot = process.env.SystemRoot): TaskPushGit {
  const wslExe = wslExePath(systemRoot);
  return (args, _cwd, extra) => exec(wslExe, wslGitArgv(distro, gitDir, args), wslEnv(extra));
}

export function readDotGitFile(worktreePath: string): string | null {
  try {
    const p = path.join(worktreePath, '.git');
    return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

export interface TaskPushDeps {
  platform?: NodeJS.Platform;
  /** The worktree's `.git` file text, or null (a folder, or none). */
  readDotGit?: (worktreePath: string) => string | null;
  /** Runs wsl.exe (a WSL distro's git). */
  wslExec?: TaskPushExec;
  /** The transports a network call may use (default https and ssh). */
  protocols?: readonly string[];
  /** A Windows path as a WSL distro sees it (default `/mnt/<drive>/…`). */
  toWslPath?: (windowsPath: string) => string | null;
}

/** `ls-remote --symref` output → the remote HEAD's branch, or null. Pure. */
export function parseLsRemoteHead(stdout: string): string | null {
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout.replace(/\r/g, ''));
  return m ? m[1] : null;
}

/** Main's git on a task's recorded repository. */
export interface TaskGitRepo {
  /** The repository config, read through `--git-dir` (includes resolved). */
  entries: GitConfigEntry[];
  /** git on the recorded repository (`--git-dir`). */
  local: (args: string[]) => Promise<GitOut>;
  /** git in the worktree: for its HEAD only. */
  head: (args: string[]) => Promise<GitOut>;
  /** `fn` runs git in a fresh clean dir whose origin is `url` (seeded with
   *  the repository's recent commits when `seed`); the dir is deleted after
   *  it. Never throws. */
  inClean: <T>(url: string, opts: { seed?: boolean }, fn: (run: (args: string[]) => Promise<GitOut>) => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; error: string }>;
  /** Why main will not write `refname` in the repository, or null. */
  refRefusal: (refname: string) => Promise<string | null>;
  /** Writes `refname` to `sha` in the repository, after the path and the
   *  commit are checked. */
  writeRef: (refname: string, sha: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function hostPathKind(p: string): PathKind {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    // A file with another name elsewhere is not one main writes to.
    if (st.isFile()) return st.nlink === 1 ? 'file' : 'other';
    return 'other';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : 'other';
  }
}

function hostRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

const STAT_KINDS: Record<string, PathKind> = { directory: 'dir', 'regular file': 'file', 'regular empty file': 'file', 'symbolic link': 'symlink' };

/** RefPathPorts inside a WSL distro: `stat` and `realpath`, argv only. */
function wslRefPorts(distro: string, exec: TaskPushExec, systemRoot: string | undefined): RefPathPorts {
  const wslExe = wslExePath(systemRoot);
  // English messages: a missing path is told apart by stat's own words.
  const env = wslEnv({ LC_ALL: 'C' });
  return {
    join: (...parts) => path.posix.join(...parts),
    caseInsensitive: false,
    kinds: async (paths) => {
      const r = await exec(wslExe, ['-d', distro, '--cd', '/', '--exec', 'stat', '--printf=%n\\0%F\\0%h\\0', '--', ...paths], env);
      const parts = r.stdout.split('\0');
      const found = new Map<string, PathKind>();
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const kind = STAT_KINDS[parts[i + 1]] ?? 'other';
        found.set(parts[i], kind === 'file' && parts[i + 2] !== '1' ? 'other' : kind);
      }
      // A path stat could not read for another reason than its absence is
      // not a folder main writes through.
      const missing = /No such file or directory/;
      return paths.map((p) => found.get(p) ?? (r.code === 0 || missing.test(r.stderr) ? 'missing' : 'other'));
    },
    realpath: async (p) => {
      const r = await exec(wslExe, ['-d', distro, '--cd', '/', '--exec', 'realpath', '-e', '--', p], env);
      const out = r.stdout.replace(/\r?\n$/, '');
      return r.code === 0 && out.startsWith('/') ? out : null;
    },
  };
}

/**
 * Main's git on the task's recorded repository, after the repository config
 * check (workerGitPreflight): refused for a ref store other than files or a
 * partial clone. A shallow repository's boundary list is copied into each
 * clean dir. Never throws.
 */
export async function openTaskGitRepo(input: TaskGitRepoInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<{ ok: true; repo: TaskGitRepo } | { ok: false; reason: 'git-failed' | 'config-refused'; error: string }> {
  const platform = deps.platform ?? process.platform;
  const fail = (error: string) => ({ ok: false as const, reason: 'git-failed' as const, error });
  const target = taskGitDirTarget(input.gitCommonDir, platform);
  if (target.kind === 'refused') return fail(target.error);
  const wslExec = deps.wslExec ?? defaultWslExec;
  // In a distro the hooks folder is a Linux path; /dev/null holds no hook.
  const safe = workerGitSafeArgs(target.kind === 'wsl' ? '/dev/null' : path.resolve(input.noHooksDir));
  let common: string;
  let ports: RefPathPorts;
  let readShallow: () => Promise<string | null>;
  let raw: TaskPushGit;
  let head: TaskPushGit;
  if (target.kind === 'wsl') {
    ports = wslRefPorts(target.distro, wslExec, process.env.SystemRoot);
    const real = await ports.realpath(target.gitDir);
    if (!real) return fail(`the task's repository ${input.gitCommonDir} could not be read`);
    common = real;
    raw = wslTaskPushGit(target.distro, common, wslExec);
    // The worktree's HEAD: through its own gitdir, in the same distro.
    const wt = taskPushGitTarget((deps.readDotGit ?? readDotGitFile)(input.worktreePath), platform);
    if (wt.kind !== 'wsl' || wt.distro.toLowerCase() !== target.distro.toLowerCase()) {
      return fail('the task\'s worktree is not in the WSL distro of its repository');
    }
    head = wslTaskPushGit(target.distro, wt.gitDir, wslExec);
    readShallow = async () => {
      const r = await wslExec(wslExePath(process.env.SystemRoot), ['-d', target.distro, '--cd', '/', '--exec', 'cat', '--', path.posix.join(common, 'shallow')], wslEnv());
      return r.code === 0 ? r.stdout : null;
    };
  } else {
    ports = { join: (...p) => path.join(...p), caseInsensitive: platform === 'win32', kinds: async (ps) => ps.map(hostPathKind), realpath: async (p) => hostRealpath(p) };
    if (!path.isAbsolute(input.gitCommonDir)) return fail('the task\'s recorded repository is not an absolute path');
    const real = hostRealpath(input.gitCommonDir);
    const same = real !== null && (platform === 'win32' ? real.toLowerCase() === input.gitCommonDir.toLowerCase() : real === input.gitCommonDir);
    if (!same) return fail(`the task's repository ${input.gitCommonDir} no longer resolves to itself`);
    common = input.gitCommonDir;
    raw = (args, _cwd, extra) => git([`--git-dir=${common}`, ...args], common, extra);
    head = git;
    readShallow = async () => {
      try {
        return fs.readFileSync(path.join(common, 'shallow'), 'utf8');
      } catch {
        return null;
      }
    };
  }
  // No object is fetched on demand from a promisor remote during a read.
  const NO_LAZY = { GIT_NO_LAZY_FETCH: '1' };
  const local = (args: string[]) => raw([...safe, ...args], input.worktreePath, NO_LAZY);
  const pre = await workerGitPreflight(local);
  if (!pre.ok) return { ok: false, reason: 'config-refused', error: pre.error };
  const own = (key: string) => pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && e.key === key)?.value;
  const refStorage = own('extensions.refstorage');
  if (refStorage !== undefined && refStorage.toLowerCase() !== 'files') {
    return { ok: false, reason: 'config-refused', error: 'the repository keeps its refs in a ref store main does not write to' };
  }
  const promisor = pre.entries.find((e) => (e.scope === 'local' || e.scope === 'worktree') && (e.key === 'extensions.partialclone' || /^remote\..+\.promisor$/.test(e.key)));
  if (promisor) return { ok: false, reason: 'config-refused', error: `the repository is a partial clone (${promisor.key})` };
  const objectFormat = (own('extensions.objectformat') ?? 'sha1').toLowerCase();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return { ok: false, reason: 'config-refused', error: `the repository's object format ${objectFormat} is not one main reads` };
  // A shallow repository: git in a clean dir reads the boundary commits from
  // the clean dir's own `shallow`, so main copies the list there.
  const isShallow = await local(['rev-parse', '--is-shallow-repository']);
  const shallowState = isShallow.code === 0 ? isShallow.stdout.trim() : '';
  if (shallowState !== 'true' && shallowState !== 'false') return fail(`git rev-parse --is-shallow-repository failed: ${isShallow.stderr.trim().slice(0, 300)}`);
  let shallowList = '';
  if (shallowState === 'true') {
    const text = await readShallow();
    const idRe = objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
    const ids = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (text === null || ids.length === 0 || !ids.every((id) => idRe.test(id))) return { ok: false, reason: 'config-refused', error: 'the repository\'s shallow list could not be read' };
    shallowList = `${[...new Set(ids)].join('\n')}\n`;
  }
  const context = parseRawGitConfigList(pre.stdout);
  const objectDir = target.kind === 'wsl' ? path.posix.join(common, 'objects') : path.join(common, 'objects');
  const cleanArgs = cleanGitConfigArgs(safe, deps.protocols ?? CLEAN_GIT_DEFAULT_PROTOCOLS);
  let owned: Array<[string, string]> | null = null;

  const inClean: TaskGitRepo['inClean'] = async (url, opts, fn) => {
    let dir: string | null = null;
    try {
      fs.mkdirSync(input.cleanRoot, { recursive: true, mode: 0o700 });
      dir = fs.mkdtempSync(path.join(input.cleanRoot, 'c-'));
      const gitDir = target.kind === 'wsl' ? (deps.toWslPath ?? toWslPath)(dir) : dir;
      if (!gitDir) return { ok: false, error: `main's folder ${dir} has no path inside WSL` };
      const cleanRaw: TaskPushGit = target.kind === 'wsl' ? wslTaskPushGit(target.distro, gitDir, wslExec) : (args, _cwd, extra) => git([`--git-dir=${gitDir}`, ...args], dir as string, extra);
      const init = await cleanRaw([...safe, 'init', '-q', '--bare', '--template=', `--object-format=${objectFormat}`], dir);
      if (init.code !== 0) return { ok: false, error: `git init failed: ${init.stderr.trim().slice(0, 300)}` };
      const set = await cleanRaw([...safe, 'config', 'remote.origin.url', url], dir);
      if (set.code !== 0) return { ok: false, error: `git config failed: ${set.stderr.trim().slice(0, 300)}` };
      if (shallowList) fs.writeFileSync(path.join(dir, 'shallow'), shallowList);
      if (opts.seed) {
        const tips = await local(['--no-replace-objects', 'for-each-ref', '--sort=-committerdate', `--count=${CLEAN_GIT_SEED_MAX}`, '--format=%(objectname) %(objecttype)', 'refs/remotes/origin', 'refs/heads']);
        if (tips.code === 0) fs.writeFileSync(path.join(dir, 'packed-refs'), cleanGitSeedPackedRefs(parseSeedTips(tips.stdout)));
      }
      if (!owned) {
        // The owner's transport settings an include adds for the recorded
        // repository's path, which the clean dir's path does not match.
        const cleanList = await cleanRaw([...safe, 'config', '-z', '--list', '--show-scope'], dir);
        if (cleanList.code !== 0) return { ok: false, error: `git config --list failed: ${cleanList.stderr.trim().slice(0, 300)}` };
        owned = transportConfigDiff(context, parseRawGitConfigList(cleanList.stdout));
      }
      const env = { ...cleanGitEnv(gitDir, objectDir, owned), ...NO_LAZY };
      const run = (args: string[]) => cleanRaw([...cleanArgs, ...args], dir as string, env);
      return { ok: true, value: await fn(run) };
    } catch (err) {
      return { ok: false, error: `main's clean git dir failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Swept at the next start (sweepTaskGitCleanDirs).
        }
      }
    }
  };

  const refRefusal = async (refname: string): Promise<string | null> => {
    const walk = await guardedRefPathRefusal(common, refname, ports);
    if (walk) return walk;
    // A ref, loose or packed, whose name is a folder of this one or under it.
    const refs = await local(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/']);
    if (refs.code !== 0) return `git for-each-ref failed: ${refs.stderr.trim().slice(0, 300)}`;
    const clash = refs.stdout.split('\n').map((r) => r.trim()).find((r) => r && r !== refname && (refname.startsWith(`${r}/`) || r.startsWith(`${refname}/`)));
    return clash ? `${clash} is in the way of ${refname}` : null;
  };
  const writeRef: TaskGitRepo['writeRef'] = async (refname, sha) => {
    if (!SHA_RE.test(sha)) return { ok: false, error: `${sha} is not a commit id` };
    const refused = await refRefusal(refname);
    if (refused) return { ok: false, error: refused };
    const there = await local(['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`]);
    if (there.code !== 0) return { ok: false, error: `the repository does not hold commit ${sha}` };
    // The ref itself (a symbolic ref there is replaced, never followed), and
    // no reflog entry.
    const set = await local(['-c', 'core.logAllRefUpdates=false', 'update-ref', '--no-deref', refname, sha]);
    return set.code === 0 ? { ok: true } : { ok: false, error: `git update-ref ${refname} failed: ${set.stderr.trim().slice(0, 300)}` };
  };

  return {
    ok: true,
    repo: {
      entries: pre.entries,
      local,
      head: (args) => head([...safe, ...args], input.worktreePath, NO_LAZY),
      inClean,
      refRefusal,
      writeRef,
    },
  };
}

/** Removes clean git dirs a previous run left behind (main's start): only
 *  ones older than this process, so a call already under way keeps its own. */
export function sweepTaskGitCleanDirs(cleanRoot: string, startedAt = Date.now() - process.uptime() * 1000): void {
  let names: string[];
  try {
    names = fs.readdirSync(cleanRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(cleanRoot, name);
    try {
      if (fs.lstatSync(p).mtimeMs < startedAt) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort: each call makes its own fresh dir.
    }
  }
}

/** Push the task branch. Never throws. `git` is main's own git (a task in a
 *  WSL distro uses that distro's, see taskGitDirTarget). */
export async function pushTaskBranch(input: TaskPushInput, git: TaskPushGit = defaultGit, deps: TaskPushDeps = {}): Promise<TaskPushResult> {
  const branchRefusal = taskPushBranchRefusal(input.branch, input.defaultBranches);
  if (branchRefusal) return { ok: false, reason: 'branch-refused', error: branchRefusal };
  const opened = await openTaskGitRepo(input, git, deps);
  if (!opened.ok) return opened;
  const { repo } = opened;
  const origin = workerOriginRefusal(repo.entries);
  if ('error' in origin) {
    return { ok: false, reason: /no origin remote/.test(origin.error) ? 'no-origin' : 'remote-refused', error: origin.error };
  }
  const named = urlNamedRemoteRefusal(repo.entries, origin.url);
  if (named) return { ok: false, reason: 'config-refused', error: named };
  const key = originUrlRepoKey(origin.url);
  if (input.expectedRepoKey !== undefined) {
    const expected = normalizeRepoKey(input.expectedRepoKey);
    if (!expected || !key || key !== expected) {
      return { ok: false, reason: 'remote-refused', error: `origin is not ${input.expectedRepoKey} (a plain https or ssh address of it)` };
    }
  }
  // The repository's own default branch, under every name it is read by:
  // GitHub's by the key, origin/HEAD, and the remote's HEAD at the pushed URL
  // (the one answer no worker-written ref can change, and no GitHub needed).
  const own: string[] = [];
  const byKey = key && input.repoDefaultBranch ? await input.repoDefaultBranch(key).catch(() => null) : null;
  if (byKey) own.push(byKey);
  const ref = await repo.local(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const name = ref.code === 0 ? ref.stdout.trim() : '';
  if (name.startsWith('refs/remotes/origin/')) own.push(name.slice('refs/remotes/origin/'.length));
  const remote = await repo.inClean(origin.url, {}, (run) => run(['ls-remote', '--symref', '--', origin.url, 'HEAD']));
  const remoteHead = remote.ok && remote.value.code === 0 ? parseLsRemoteHead(remote.value.stdout) : null;
  if (remoteHead) own.push(remoteHead);
  if (own.length > 0) {
    const refusal = taskPushBranchRefusal(input.branch, [...input.defaultBranches, ...own]);
    if (refusal) return { ok: false, reason: 'branch-refused', error: refusal };
  }
  // HEAD is resolved once: that commit is what is pushed, set as
  // origin/<branch> and reported (and recorded by task.push), even if HEAD
  // moves.
  const head = await repo.head(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !SHA_RE.test(sha)) {
    return { ok: false, reason: 'git-failed', error: `git rev-parse HEAD failed: ${head.stderr.trim().slice(0, 500)}` };
  }
  // origin/<branch> is checked before the push, so a push never lands with a
  // path main will not write to.
  const upstream = `refs/remotes/origin/${input.branch}`;
  const refused = await repo.refRefusal(upstream);
  if (refused) return { ok: false, reason: 'config-refused', error: `main will not write ${upstream}: ${refused}` };
  const pushed = await repo.inClean(origin.url, {}, (run) => run(taskPushArgs(input.branch, origin.url, sha)));
  if (!pushed.ok) return { ok: false, reason: 'git-failed', error: pushed.error };
  const res = pushed.value;
  const output = `${res.stdout}\n${res.stderr}`.trim().slice(0, 2000);
  if (res.code !== 0) {
    // --porcelain marks a refused ref with `!` (non-fast-forward, remote hook).
    const rejected = /^!\t/m.test(res.stdout);
    return { ok: false, reason: rejected ? 'rejected' : 'git-failed', error: output || `git push exited ${res.code}` };
  }
  // origin/<branch>, as a push to origin would set it.
  const set = await repo.writeRef(upstream, sha);
  return { ok: true, branch: input.branch, remote: 'origin', head: sha, output: set.ok ? output : `${output}\norigin/${input.branch} was not set: ${set.error}`.trim() };
}
