// The Git page's ship button, main side: the current branch's status (one
// `git status --porcelain=v2 --branch`, whether a merge or cherry-pick is in
// progress, the default branch, the last commit subject, and the branch's PR
// from the shared PR cache) and the three writes it can start: commit
// everything, push to the upstream, create a PR.
//
// Every command is argv (never a shell); a push never prompts and names its
// refspec, so push.default / remote.*.push cannot publish other branches.
// Each write is pinned to the branch and HEAD the user saw: it is refused if
// either moved, checked again right before the write.
//
// A failed write carries a `reason` when git's output says which of the
// common causes it was (signing, a protected branch, a remote that moved on,
// a refused key or sign-in, a working folder that is gone); the UI words it
// and offers the one next step (renderer/components/Git/ShipButton.tsx).
import { describeScanFailure, describeSecretFindings, type SecretFinding } from '../../shared/secretGuard';
import { reviewRange, scanCommits, scanDiff, spawnGitLines, type GitLines, type SecretScanResult } from './secretScan';
import { secretGuardEnabled } from './secretGuardSetting';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExecEnv } from '../../shared/execEnv';
import { configuredForge, forgeHosts } from '../../shared/forgeHosts';
import { ghIssueEnv } from '../github/GhIssueService';
import { isGithubForgeHost, parseRemoteHost } from '../github/PrProvider';
import { prStatusCache } from '../metadata/PrStatusCache';
import type { PrStatus } from '../../shared/types';

export interface ShipStatus {
  /** null when detached. */
  branch: string | null;
  /** The HEAD commit ('' in an empty repo). */
  head: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, staged or untracked files (conflicted ones are counted apart). */
  dirty: number;
  /** Unmerged (conflicted) files. */
  conflicts: number;
  /** A merge or cherry-pick in progress in this worktree. */
  inProgress: boolean;
  /** The remote's default branch, null when it cannot be read. */
  defaultBranch: string | null;
  /** The last commit's subject, the Create PR title's starting point. */
  headSubject: string;
  pr: { state: PrStatus['state']; url: string } | null;
}

/** The branch and HEAD a write was asked for. */
export interface ShipExpect {
  branch: string;
  head: string;
}

/** A failure the UI can put in plain words, with one next step. */
export type ShipFailureReason =
  /** gpg / ssh commit signing failed (including a signer that wanted a passphrase typed). */
  | 'signing'
  /** The remote refuses direct pushes to this branch. */
  | 'protected'
  /** The remote branch has commits this one lacks. */
  | 'remote-ahead'
  /** The remote refused the key or the sign-in. */
  | 'auth'
  /** The repository's folder is not there any more. */
  | 'missing-folder';

export type ShipStatusResult = { ok: true; status: ShipStatus } | { ok: false; error: string; reason?: 'missing-folder' };
export type ShipActionResult =
  | { ok: true; url?: string }
  /** `error`: git's own output (trimmed), shown collapsed under the plain words.
   *  `secrets`: refused because the change carries secret files or key-shaped
   *  values (shared/secretGuard.ts); the UI words it from these. `reason`:
   *  one of the causes the UI words itself; `forge` names the remote's host
   *  kind for an `auth` failure, when known. */
  | {
    ok: false;
    error: string;
    secrets?: SecretFinding[];
    secretScanFailed?: true;
    reason?: ShipFailureReason;
    forge?: 'github' | 'gitlab';
  };

/** Options for one commit. */
export interface ShipCommitOptions {
  /** Commit this once without signing (`-c commit.gpgsign=false` on this one
   *  git call); the user's git config is left as it is. */
  noSign?: boolean;
}

/** Longest commit message / PR title accepted. */
export const SHIP_TEXT_MAX = 10_000;
/** How long a default branch read from the remote (ls-remote) is believed. */
const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;

/** branch / HEAD / upstream / ahead-behind / dirty / conflicts from `git status --porcelain=v2 --branch`. Pure. */
export function parseStatusV2(raw: string): Pick<ShipStatus, 'branch' | 'head' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'dirty' | 'conflicts'> {
  let branch: string | null = null;
  let head = '';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  let conflicts = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      head = oid === '(initial)' ? '' : oid;
    } else if (line.startsWith('# branch.head ')) {
      const h = line.slice('# branch.head '.length).trim();
      branch = h === '(detached)' ? null : h;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('u ')) {
      conflicts++;
    } else if (/^[12?] /.test(line)) {
      dirty++;
    }
  }
  return { branch, head, detached: branch === null, upstream, ahead, behind, dirty, conflicts };
}

/** The default branch from `git ls-remote --symref <remote> HEAD`. Pure. */
export function parseSymrefHead(raw: string): string | null {
  const m = raw.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  return m ? m[1] : null;
}

type Run = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string }>;

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs `cmd` with no terminal to ask on: stdin is /dev/null and, off
 *  Windows, the child leads a new session (no controlling TTY), and GPG_TTY is
 *  dropped. A signer or ssh that wants a passphrase typed (pinentry-curses,
 *  ssh-keygen reading /dev/tty or stdin) then fails at once with its own
 *  message, instead of waiting out the timeout on a prompt nobody can see.
 *  gpg-agent (a cached passphrase, a GUI pinentry) and ssh-agent are reached
 *  through their sockets and keep working. A timeout kills the whole process
 *  group, signer included. Rejects like execFile: an Error carrying `code`,
 *  `signal`, `killed`, `stdout` and `stderr`. */
export const spawnRun: Run = (cmd, args, opts) => new Promise((resolve, reject) => {
  const posix = process.platform !== 'win32';
  const env = { ...opts.env };
  delete env.GPG_TTY;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix, windowsHide: true });
  } catch (err) {
    reject(err);
    return;
  }
  let stdout = '';
  let stderr = '';
  let killed = false;
  let settled = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(kill, opts.timeout);
  const take = (to: 'out' | 'err') => (chunk: string) => {
    if (to === 'out') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > MAX_OUTPUT) kill();
  };
  child.stdout?.setEncoding('utf8').on('data', take('out'));
  child.stderr?.setEncoding('utf8').on('data', take('err'));
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(Object.assign(err, { stdout, stderr }));
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0 && !killed) resolve({ stdout });
    else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} failed${killed ? ' (timed out)' : ''}`), { code, signal, killed, stdout, stderr }));
  });
});

/** git's own words for a failure: its stderr, else the error's message. */
function failure(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().slice(0, 2000);
}

const SIGNING = /failed to sign the data|Couldn't load public key|user\.signingkey needs to be set|incorrect passphrase supplied|Enter passphrase for|Load key "|signing failed|No secret key|gpg: skipped "/i;
const PROTECTED = /\bGH006\b|protected branch|Changes must be made through a pull request|can only be modified through pull requests|\bTF402455\b/i;
const REMOTE_AHEAD = /\[rejected\][^\n]*\((?:fetch first|non-fast-forward)\)|Updates were rejected because the (?:remote contains work|tip of your current branch is behind)/;
const AUTH = /Permission denied \(publickey|Permission denied, please try again|Authentication failed for|could not read (?:Username|Password) for|Permission to \S+ denied to|HTTP Basic: Access denied|The requested URL returned error: 40[13]|gh auth login|HTTP 401/i;

/** Which of the causes the UI words itself `output` (a failed command's
 *  stderr) shows, for `action`; null for anything else. Pure. */
export function classifyShipFailure(action: 'commit' | 'push' | 'createPr', output: string): Exclude<ShipFailureReason, 'missing-folder'> | null {
  if (action === 'commit') return SIGNING.test(output) ? 'signing' : null;
  if (action === 'push') {
    if (PROTECTED.test(output)) return 'protected';
    if (REMOTE_AHEAD.test(output)) return 'remote-ahead';
  }
  return AUTH.test(output) ? 'auth' : null;
}

/** github / gitlab from a remote URL's host, when it is known to be one. */
function forgeOfUrl(url: string): 'github' | 'gitlab' | undefined {
  const host = parseRemoteHost(url);
  if (!host) return undefined;
  if (isGithubForgeHost(host)) return 'github';
  return configuredForge(host, forgeHosts()) === 'gitlab' || host.includes('gitlab') ? 'gitlab' : undefined;
}

class Moved extends Error {}

/** A spawn that failed because `cwd` is gone. Node answers ENOENT for a
 *  missing cwd as for a missing binary, so the disk is asked. */
function folderGone(err: unknown, cwd: string, exists: (p: string) => boolean): boolean {
  return (err as { code?: unknown })?.code === 'ENOENT' && !exists(cwd);
}

/** A git / gh failure in the ship result's shape. */
type Failed = Extract<ShipActionResult, { ok: false }>;

export class ShipActions {
  private defaultBranches = new Map<string, { value: string | null; at: number }>();

  constructor(
    private run: Run = spawnRun,
    private prOf: (cwd: string, branch: string) => Promise<PrStatus | null> = (cwd, branch) => prStatusCache.get(cwd, branch),
    private forgetPr: (cwd: string, branch: string) => void = (cwd, branch) => prStatusCache.invalidate(cwd, branch),
    private now: () => number = Date.now,
    private exists: (p: string) => boolean = existsSync,
    /** Streams the secret check's git reads (shared/secretGuard.ts). */
    private gitLines: (cwd: string, env?: NodeJS.ProcessEnv) => GitLines = spawnGitLines,
  ) {}

  private git(args: string[], cwd: string, timeout = 30_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stdout: string }> {
    return this.run('git', args, { cwd, env: { ...getExecEnv(), ...extraEnv }, timeout });
  }

  /** origin/HEAD, else the remote's HEAD as ls-remote reports it (cached), else null. */
  private async defaultBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
      const name = stdout.trim().replace(/^origin\//, '');
      if (name) return name;
    } catch { /* origin/HEAD not set: ask the remote */ }
    const hit = this.defaultBranches.get(cwd);
    if (hit && this.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.value;
    let value: string | null = null;
    try {
      value = parseSymrefHead((await this.git(['ls-remote', '--symref', 'origin', 'HEAD'], cwd, 15_000, { GIT_TERMINAL_PROMPT: '0' })).stdout);
    } catch { /* unreachable remote: unknown */ }
    this.defaultBranches.set(cwd, { value, at: this.now() });
    return value;
  }

  /** A refusal when the secret check found secret files or key-shaped values,
   *  or could not run (fail closed); null when the change is clean. */
  private secretRefusal(scan: SecretScanResult, action: string): ShipActionResult | null {
    if (!scan.ok) return { ok: false, error: describeScanFailure(action), secretScanFailed: true };
    if (scan.findings.length) return { ok: false, error: describeSecretFindings(scan.findings, action), secrets: scan.findings };
    return null;
  }

  /** A merge or cherry-pick in progress in the worktree at `cwd`. */
  private async inProgress(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'CHERRY_PICK_HEAD'], cwd);
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean).some((p) => this.exists(path.resolve(cwd, p)));
    } catch {
      return false;
    }
  }

  async status(cwd: string): Promise<ShipStatusResult> {
    let parsed: ReturnType<typeof parseStatusV2>;
    try {
      parsed = parseStatusV2((await this.git(['status', '--porcelain=v2', '--branch'], cwd)).stdout);
    } catch (err) {
      return folderGone(err, cwd, this.exists) ? { ok: false, error: failure(err), reason: 'missing-folder' } : { ok: false, error: failure(err) };
    }
    const [inProgress, defaultBranch, headSubject, pr] = await Promise.all([
      this.inProgress(cwd),
      this.defaultBranch(cwd),
      this.git(['log', '-1', '--format=%s'], cwd).then(({ stdout }) => stdout.trim()).catch(() => ''),
      parsed.branch ? this.prOf(cwd, parsed.branch).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      ok: true,
      status: { ...parsed, inProgress, defaultBranch, headSubject, pr: pr ? { state: pr.state, url: pr.url } : null },
    };
  }

  /** Runs `work` with GIT_INDEX_FILE pointing at a throwaway copy of the
   *  worktree's index, removed afterwards. */
  private async withIndexCopy<T>(cwd: string, work: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const { stdout } = await this.git(['rev-parse', '--git-path', 'index'], cwd);
    const real = path.resolve(cwd, stdout.trim());
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-secret-index-'));
    const copy = path.join(dir, 'index');
    try {
      if (existsSync(real)) copyFileSync(real, copy);
      return await work({ GIT_INDEX_FILE: copy });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Throws Moved unless the worktree is still on `expect`'s branch at its HEAD. */
  private async verify(cwd: string, expect: ShipExpect): Promise<void> {
    // A folder that is gone is said as such, not as a moved branch.
    const gone = (err: unknown) => { if (folderGone(err, cwd, this.exists)) throw err; return ''; };
    const [head, branch] = await Promise.all([
      this.git(['rev-parse', 'HEAD'], cwd).then(({ stdout }) => stdout.trim()).catch(gone),
      this.git(['symbolic-ref', '-q', '--short', 'HEAD'], cwd).then(({ stdout }) => stdout.trim()).catch(() => ''),
    ]);
    if (head !== expect.head || branch !== expect.branch) throw new Moved('the branch changed since this was opened; check again');
  }

  /** `err` as a failed result: plain-worded when it is one of the known causes. */
  private async failed(action: 'commit' | 'push' | 'createPr', cwd: string, err: unknown, remote?: string): Promise<Failed> {
    if (err instanceof Moved) return { ok: false, error: err.message };
    const error = failure(err);
    if (folderGone(err, cwd, this.exists)) return { ok: false, error, reason: 'missing-folder' };
    let reason = classifyShipFailure(action, error);
    // A signer that outlived the timeout leaves no words; with signing on, it was the signer.
    if (!reason && action === 'commit' && (err as { killed?: boolean })?.killed) {
      const signing = await this.git(['config', '--type=bool', '--get', 'commit.gpgsign'], cwd).then(({ stdout }) => stdout.trim(), () => '');
      if (signing === 'true') reason = 'signing';
    }
    if (!reason) return { ok: false, error };
    if (reason !== 'auth') return { ok: false, error, reason };
    if (action === 'createPr') return { ok: false, error, reason, forge: 'github' };
    const url = remote ? await this.git(['remote', 'get-url', remote], cwd).then(({ stdout }) => stdout.trim(), () => '') : '';
    const forge = url ? forgeOfUrl(url) : undefined;
    return { ok: false, error, reason, ...(forge ? { forge } : {}) };
  }

  /** Stage every change (tracked and untracked) and commit it on `expect`.
   *  `opts.noSign` turns signing off for this one commit only. */
  async commit(cwd: string, message: string, expect: ShipExpect, opts: ShipCommitOptions = {}): Promise<ShipActionResult> {
    const msg = message.trim();
    if (!msg) return { ok: false, error: 'a commit message is required' };
    if (msg.length > SHIP_TEXT_MAX) return { ok: false, error: 'the commit message is too long' };
    // `-c` on this invocation only: the user's git config is never written.
    const commitArgs = [...(opts.noSign ? ['-c', 'commit.gpgsign=false'] : []), 'commit', '-m', msg];
    try {
      await this.verify(cwd, expect);
      if (secretGuardEnabled()) {
        // Staged and checked in a COPY of the index, then committed from that
        // same copy: the commit is exactly the tree that was checked, and a
        // refusal leaves the user's own staging as it was.
        return await this.withIndexCopy(cwd, async (env) => {
          await this.git(['add', '-A'], cwd, 30_000, env);
          const refused = this.secretRefusal(await scanDiff(this.gitLines(cwd, env), ['--cached']), 'committed');
          if (refused) return refused;
          await this.verify(cwd, expect);
          await this.git(commitArgs, cwd, 60_000, env);
          // The real index catches up with the commit, as `add -A` + `commit` leaves it.
          try {
            await this.git(['reset', '-q'], cwd);
          } catch (err) {
            return { ok: false, error: `committed, but the staging area could not be updated (${failure(err)}); run "git reset" in this repository` };
          }
          return { ok: true };
        });
      }
      await this.git(['add', '-A'], cwd);
      await this.verify(cwd, expect);
      await this.git(commitArgs, cwd, 60_000);
      return { ok: true };
    } catch (err) {
      return this.failed('commit', cwd, err);
    }
  }

  /** Push exactly `expect.head` to the branch's upstream branch on its remote;
   *  never prompts for credentials. */
  async push(cwd: string, expect: ShipExpect): Promise<ShipActionResult> {
    let remote = '';
    try {
      const cfg = (key: string) => this.git(['config', '--get', key], cwd).then(({ stdout }) => stdout.trim()).catch((err) => {
        if (folderGone(err, cwd, this.exists)) throw err;
        return '';
      });
      const [rem, merge] = await Promise.all([cfg(`branch.${expect.branch}.remote`), cfg(`branch.${expect.branch}.merge`)]);
      remote = rem;
      if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) return { ok: false, error: 'the branch has no upstream branch on a remote' };
      await this.verify(cwd, expect);
      if (secretGuardEnabled()) {
        // Every commit the destination remote's tracking refs lack, each commit's own change.
        const refused = this.secretRefusal(await scanCommits(this.gitLines(cwd), [expect.head, '--not', `--remotes=${remote}`]), 'pushed');
        if (refused) return refused;
      }
      await this.git(['push', remote, `${expect.head}:${merge}`], cwd, 120_000, { GIT_TERMINAL_PROMPT: '0' });
      return { ok: true };
    } catch (err) {
      return this.failed('push', cwd, err, remote && remote !== '.' ? remote : undefined);
    }
  }

  /** `gh pr create --fill` for `expect`'s branch with the given title; answers the new PR's URL. */
  async createPr(cwd: string, title: string, expect: ShipExpect): Promise<ShipActionResult> {
    const t = title.trim();
    if (!t) return { ok: false, error: 'a title is required' };
    if (t.length > SHIP_TEXT_MAX) return { ok: false, error: 'the title is too long' };
    try {
      await this.verify(cwd, expect);
      if (secretGuardEnabled()) {
        // The commits the PR shows: not on its base (gh's own per-branch
        // gh-merge-base, else the default branch).
        const pinned = await this.git(['config', '--get', `branch.${expect.branch}.gh-merge-base`], cwd).then(({ stdout }) => stdout.trim(), () => '');
        const base = pinned || await this.defaultBranch(cwd);
        const run = this.gitLines(cwd);
        const refused = this.secretRefusal(
          await scanCommits(run, await reviewRange(run, expect.head, base ? `refs/remotes/origin/${base}` : null)),
          'sent in a pull request',
        );
        if (refused) return refused;
      }
      const { stdout } = await this.run(process.platform === 'win32' ? 'gh.exe' : 'gh', ['pr', 'create', '--fill', '--head', expect.branch, '--title', t], {
        cwd,
        env: ghIssueEnv(),
        timeout: 60_000,
      });
      this.forgetPr(cwd, expect.branch);
      const url = stdout.split('\n').map((l) => l.trim()).find((l) => /^https:\/\//.test(l));
      return { ok: true, ...(url ? { url } : {}) };
    } catch (err) {
      return this.failed('createPr', cwd, err);
    }
  }
}

export const shipActions = new ShipActions();
