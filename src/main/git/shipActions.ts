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
import { describeScanFailure, describeSecretFindings, type SecretFinding } from '../../shared/secretGuard';
import { reviewRange, scanCommits, scanDiff, spawnGitLines, type GitLines, type SecretScanResult } from './secretScan';
import { secretGuardEnabled } from './secretGuardSetting';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getExecEnv } from '../../shared/execEnv';
import { ghIssueEnv } from '../github/GhIssueService';
import { prStatusCache } from '../metadata/PrStatusCache';
import type { PrStatus } from '../../shared/types';

const execFileAsync = promisify(execFile);

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

export type ShipStatusResult = { ok: true; status: ShipStatus } | { ok: false; error: string };
export type ShipActionResult =
  | { ok: true; url?: string }
  /** `secrets`: refused because the change carries secret files or key-shaped
   *  values (shared/secretGuard.ts); the UI words it from these. */
  | { ok: false; error: string; secrets?: SecretFinding[]; secretScanFailed?: true };

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

const defaultRun: Run = (cmd, args, opts) =>
  execFileAsync(cmd, args, { ...opts, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

function failure(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr || e?.message || String(err)).trim().slice(0, 500);
}

class Moved extends Error {}

export class ShipActions {
  private defaultBranches = new Map<string, { value: string | null; at: number }>();

  constructor(
    private run: Run = defaultRun,
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
      return { ok: false, error: failure(err) };
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
    const [head, branch] = await Promise.all([
      this.git(['rev-parse', 'HEAD'], cwd).then(({ stdout }) => stdout.trim()).catch(() => ''),
      this.git(['symbolic-ref', '-q', '--short', 'HEAD'], cwd).then(({ stdout }) => stdout.trim()).catch(() => ''),
    ]);
    if (head !== expect.head || branch !== expect.branch) throw new Moved('the branch changed since this was opened; check again');
  }

  /** Stage every change (tracked and untracked) and commit it on `expect`. */
  async commit(cwd: string, message: string, expect: ShipExpect): Promise<ShipActionResult> {
    const msg = message.trim();
    if (!msg) return { ok: false, error: 'a commit message is required' };
    if (msg.length > SHIP_TEXT_MAX) return { ok: false, error: 'the commit message is too long' };
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
          await this.git(['commit', '-m', msg], cwd, 60_000, env);
          // The real index catches up with the commit, as `add -A` + `commit` leaves it.
          await this.git(['reset', '-q'], cwd).catch(() => undefined);
          return { ok: true };
        });
      }
      await this.git(['add', '-A'], cwd);
      await this.verify(cwd, expect);
      await this.git(['commit', '-m', msg], cwd, 60_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Moved ? err.message : failure(err) };
    }
  }

  /** Push exactly `expect.head` to the branch's upstream branch on its remote;
   *  never prompts for credentials. */
  async push(cwd: string, expect: ShipExpect): Promise<ShipActionResult> {
    try {
      const cfg = (key: string) => this.git(['config', '--get', key], cwd).then(({ stdout }) => stdout.trim()).catch(() => '');
      const [remote, merge] = await Promise.all([cfg(`branch.${expect.branch}.remote`), cfg(`branch.${expect.branch}.merge`)]);
      if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) return { ok: false, error: 'the branch has no upstream branch on a remote' };
      await this.verify(cwd, expect);
      if (secretGuardEnabled()) {
        // Every commit no remote-tracking ref has yet, each commit's own change.
        const refused = this.secretRefusal(await scanCommits(this.gitLines(cwd), [expect.head, '--not', '--remotes']), 'pushed');
        if (refused) return refused;
      }
      await this.git(['push', remote, `${expect.head}:${merge}`], cwd, 120_000, { GIT_TERMINAL_PROMPT: '0' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Moved ? err.message : failure(err) };
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
      return { ok: false, error: err instanceof Moved ? err.message : failure(err) };
    }
  }
}

export const shipActions = new ShipActions();
