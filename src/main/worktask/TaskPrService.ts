/**
 * TaskPrService — J3 §2 D2. 태스크 산출물의 1클릭 PR(main측 오케스트레이션).
 *
 * gh 4중 게이트(§2):
 *   ① `gh --version` + `gh auth status` — 버전≠인증(G3). 부재·미인증은 안내 +
 *      브라우저 폴백 사유 반환(예외 없음).
 *   ② dirty 검사 — 미커밋 변경이 있으면 "PR에 포함 안 됨" 차단 + 커밋 안내(CX7).
 *   ③ `git push -u origin {branch}` — execFile argv(셸 조립 금지 계약 G6).
 *   ④ `gh pr create --head {branch} --title --body --base {base}` — --base 명시
 *      (CL4: base 추론 실패 방지. base = repo default via
 *      `gh repo view --json defaultBranchRef`).
 *
 * 멱등 재진입(CX5+G4): pr create 실패 시 `gh pr list --head {branch}` 조회 —
 * 기존 PR 있으면 URL 회수로 성공 수렴. push의 "이미 존재"는 fast-forward면 무해
 * 통과. half-done(push만 성공) 상태는 재클릭이 자연 수렴한다.
 *
 * 성공 시: prUrl을 데몬 task.mission.update로 커밋 + PrStatusCache.invalidate로
 * 5분 TTL 공백 제거(CX8).
 *
 * fork 워크플로(§7·CL9): origin remote 부재는 명시 에러(자동 추측 금지).
 *
 * GitLab: when origin's push host is not GitHub's (hostLane.isGitlabRepoKey),
 * the same steps run with glab — the gate is `glab --version` plus a `user`
 * read (a definite sign-out → gh-unauth, a host that did not answer → a
 * transient error), the base is the project's default branch, and the merge
 * request is opened over REST inside origin's project
 * (GlabPrService.createMergeRequest). Re-entry returns the open MR for that
 * source → target. The push is the GitHub path's. Forks and drafts are not
 * handled, as on GitHub. A host the glab gate refuses may still be GitHub
 * (Enterprise on its own domain, an ssh alias), so the gh path runs next,
 * pinned to origin's repository (`-R`; an ssh alias resolved by `ssh -G`), so
 * another remote is never the one gh reads; if gh cannot read that
 * repository either, the glab refusal is the answer.
 *
 * Both paths refuse a branch name `git check-ref-format --branch` does not
 * return unchanged, or one with `:`, `+`, `^`, `~`, `@{`, a leading `-` or
 * `refs/`, before anything is pushed (a refspec, never a name). Right before
 * the push both re-read origin's push URL and refuse one that is not the
 * approved (`pushTarget`) or first-read one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKTASK_PR_URL_RE, githubPullUrlHost, isGithubPullUrl } from '../../shared/workTask';
import { forgeHosts } from '../../shared/forgeHosts';
import { getExecEnv } from '../../shared/execEnv';
import { parseRemoteKey } from '../github/PrProvider';
import { isGitlabRepoKey } from '../github/hostLane';
import { GLAB_ENV, glabLoginHint, glabPrService, type GlabPrService } from '../github/GlabPrService';
import { scanCommits, secretRefusal, spawnGitLines, type GitLines } from '../git/secretScan';
import { secretGuardEnabled } from '../git/secretGuardSetting';
import type { SecretFinding } from '../../shared/secretGuard';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 60_000;

/** The glab side of the GitLab path (GlabPrService; injected in tests). */
export type PrGlabPort = Pick<GlabPrService, 'loginOrSignOut' | 'defaultBranch' | 'createMergeRequest' | 'openMergeRequestOf'>;

/** gh를 대화형으로 절대 멈추지 않게 하는 환경(로그인 프롬프트·pager 봉쇄). */
const GH_ENV = { ...getExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };

/** 데몬 RPC 최소 표면(prUrl 커밋 — 테스트 주입 가능). */
export interface PrDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** PrStatusCache 무효화 최소 표면(테스트 주입 가능). */
export interface PrCachePort {
  invalidate(cwd: string, branch: string): void;
}

/** exec 최소 표면(테스트 주입). {stdout,stderr} 또는 throw(비0 종료). */
export type PrExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface TaskPrServiceOptions {
  daemon: PrDaemonPort;
  cache?: PrCachePort;
  exec?: PrExec;
  glab?: PrGlabPort;
  /** git for the pre-push secret check, in `cwd` (default: spawned, streamed). */
  scanGit?: (cwd: string) => GitLines;
  /** Settings › General's password and key check (default: its live value). */
  secretGuard?: () => boolean;
}

export interface CreatePrInput {
  taskId: string;
  verifiedWorkspaceId: string;
  worktreePath: string;
  branch: string;
  /** PR 제목(태스크 title). */
  title: string;
  /** PR 본문(선택 — 기본 자동 1줄). */
  body?: string;
  /** origin's push host/project a human approved (`''` when it named none).
   *  The push is refused when origin's push URL reads otherwise right
   *  before it. */
  pushTarget?: string;
}

export type CreatePrResult =
  | {
      ok: true;
      prUrl: string;
      /** pr create 실패 후 기존 PR URL을 회수해 수렴함(멱등 재진입). */
      recovered?: boolean;
      /** prUrl 데몬 커밋 실패(비치명 — PR 자체는 성립). */
      commitPending?: boolean;
      /** GitLab only: the merge request's iid (`!n`); prUrl is its page. */
      mrIid?: number;
    }
  | {
      ok: false;
      reason: 'gh-missing' | 'gh-unauth' | 'dirty' | 'no-origin' | 'push-failed' | 'pr-failed' | 'secrets' | 'error';
      error: string;
      /** `secrets`: the Git page's push check refused (secretRefusal). */
      secrets?: SecretFinding[];
      secretScanFailed?: true;
      /** 브라우저 폴백 안내(gh 부재·미인증 시). */
      browseFallback?: string;
    };

export class TaskPrService {
  private readonly daemon: PrDaemonPort;
  private readonly cache: PrCachePort | undefined;
  private readonly exec: PrExec;
  private readonly glab: PrGlabPort;
  private readonly scanGit: (cwd: string) => GitLines;
  private readonly secretGuard: () => boolean;

  constructor(opts: TaskPrServiceOptions) {
    this.daemon = opts.daemon;
    this.cache = opts.cache;
    this.exec = opts.exec ?? (execFileAsync as unknown as PrExec);
    this.glab = opts.glab ?? glabPrService;
    this.scanGit = opts.scanGit ?? ((cwd) => spawnGitLines(cwd));
    this.secretGuard = opts.secretGuard ?? secretGuardEnabled;
  }

  /** The Git page's push check on the branch's commits origin lacks; null to go ahead. */
  private async secretsRefusal(worktreePath: string, branch: string): Promise<CreatePrResult | null> {
    if (!this.secretGuard()) return null;
    const refused = secretRefusal(await scanCommits(this.scanGit(worktreePath), [`refs/heads/${branch}`, '--not', '--remotes=origin']), 'pushed');
    return refused ? { ok: false, reason: 'secrets', ...refused } : null;
  }

  private gh(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
    });
  }

  private git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.exec('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: getExecEnv(),
      windowsHide: true,
    });
  }

  async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    const { worktreePath, branch, title } = input;
    const body = input.body && input.body.length > 0 ? input.body : `wmux fan-out task: ${title}`;

    const badBranch = await this.branchRefusal(worktreePath, branch);
    if (badBranch) return badBranch;

    // A GitLab origin takes the glab path. No origin, or a URL that names no
    // host/project, stays on the gh path, which refuses it as before. A host
    // glab refuses goes on to gh (it may be GitHub on its own domain).
    const key = await this.originKey(worktreePath);
    const target = input.pushTarget ?? key ?? '';
    const moved = this.targetMoved(target, key ?? '');
    if (moved) return moved;
    if (key && isGitlabRepoKey(key)) {
      const refused = await this.glabGate(worktreePath, key, branch);
      if (!refused) return this.createMr(input, key, body, target);
      const ghRepo = await this.ghRepoOf(worktreePath, key);
      if (!ghRepo) return refused;
      return this.createGh(input, body, target, { glabRefusal: refused, ghRepo });
    }
    return this.createGh(input, body, target);
  }

  /** The refusal when origin's push URL (`now`) is not the one `target`
   *  names; null when it is. */
  private targetMoved(target: string, now: string): CreatePrResult | null {
    if (target === now) return null;
    return {
      ok: false,
      reason: 'error',
      error:
        `origin's push URL changed (${target || 'unknown'} → ${now || 'unknown'}), so where it was approved to go is not ` +
        'where it would go — nothing was pushed; read the new state and ask again',
    };
  }

  /** Re-read origin's push URL right before a push: the refusal when it is
   *  no longer `target`, else null. */
  private async pushTargetMoved(worktreePath: string, target: string): Promise<CreatePrResult | null> {
    return this.targetMoved(target, (await this.originKey(worktreePath)) ?? '');
  }

  /** origin's key as gh names it (`-R`): a dotless ssh alias resolved to its
   *  real host with `ssh -G` (as gh itself does). Null when it cannot be. */
  private async ghRepoOf(worktreePath: string, key: string): Promise<string | null> {
    const [host, ...rest] = key.split('/');
    if (host.includes('.')) return key;
    if (!/^[a-z0-9][\w.-]*$/i.test(host)) return null;
    try {
      const { stdout } = await this.exec(process.platform === 'win32' ? 'ssh.exe' : 'ssh', ['-G', host], {
        cwd: worktreePath,
        timeout: GH_TIMEOUT_MS,
        env: getExecEnv(),
        windowsHide: true,
      });
      const real = /^hostname\s+(\S+)\s*$/im.exec(stdout)?.[1]?.toLowerCase() ?? '';
      return /^[a-z0-9][\w.-]*\.[\w.-]+$/.test(real) ? [real, ...rest].join('/') : null;
    } catch {
      return null;
    }
  }

  /** The gh path. After a glab refusal of a non-GitHub host, every gh call
   *  names `ghRepo` (origin's repository), and a gh that is missing, signed
   *  out or cannot read it answers that refusal instead, before anything is
   *  pushed. */
  private async createGh(
    input: CreatePrInput,
    body: string,
    target: string,
    fallback?: { glabRefusal: CreatePrResult; ghRepo: string },
  ): Promise<CreatePrResult> {
    const { taskId, verifiedWorkspaceId, worktreePath, branch, title } = input;
    const glabRefusal = fallback?.glabRefusal;
    const ghRepo = fallback?.ghRepo;

    // ── ① gh 게이트: 버전 + 인증(G3 — 버전≠인증) ──
    try {
      await this.gh(['--version'], worktreePath);
    } catch {
      if (glabRefusal) return glabRefusal;
      return {
        ok: false,
        reason: 'gh-missing',
        error: 'GitHub CLI (gh) is not installed.',
        browseFallback: `브라우저에서 직접 PR을 생성하세요: 브랜치 ${branch}를 push 후 GitHub 비교 화면 이용`,
      };
    }
    try {
      await this.gh(['auth', 'status'], worktreePath);
    } catch {
      if (glabRefusal) return glabRefusal;
      return {
        ok: false,
        reason: 'gh-unauth',
        error: 'GitHub CLI is not signed in — run `gh auth login` and try again.',
        browseFallback: `또는 브라우저에서 브랜치 ${branch}로 직접 PR을 생성하세요`,
      };
    }
    // After a glab refusal, gh must see the repository before anything is pushed.
    let earlyBase: string | undefined;
    if (glabRefusal) {
      const seen = await this.ghDefaultBranch(worktreePath, ghRepo);
      if (!seen.ok || !seen.base) return glabRefusal;
      earlyBase = seen.base;
    }

    // ── ② dirty 검사(CX7): 미커밋 변경은 PR에 안 들어감 → 차단 + 커밋 안내 ──
    try {
      const { stdout } = await this.git(['status', '--porcelain'], worktreePath);
      if (stdout.trim().length > 0) {
        return {
          ok: false,
          reason: 'dirty',
          error: 'The worktree has uncommitted changes — they would not be in the PR. Commit them first.',
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git status failed: ${errMsg(err)}` };
    }

    // origin remote 존재 검증(fork·다중 remote 자동 추측 금지 — §7·CL9).
    try {
      const { stdout } = await this.git(['remote'], worktreePath);
      const remotes = stdout.split('\n').map((r) => r.trim()).filter(Boolean);
      if (!remotes.includes('origin')) {
        return {
          ok: false,
          reason: 'no-origin',
          error: `No origin remote (remotes: ${remotes.join(', ') || 'none'}) — the PR head is not guessed. Set up origin.`,
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git remote failed: ${errMsg(err)}` };
    }

    // ── ③ push -u origin -- {branch}(execFile argv + `--` 세퍼레이터 — F6: 브랜치명이
    // 옵션으로 오인되는 표면 차단). 이미 존재(fast-forward)면 무해 통과.
    const movedBeforePush = await this.pushTargetMoved(worktreePath, target);
    if (movedBeforePush) return movedBeforePush;
    const secrets = await this.secretsRefusal(worktreePath, branch);
    if (secrets) return secrets;
    try {
      await this.git(['push', '-u', 'origin', '--', branch], worktreePath);
    } catch (err) {
      return { ok: false, reason: 'push-failed', error: `git push failed: ${errMsg(err)}` };
    }

    // base = repo default(CL4·[J2대조]4 — fan-out 원본 브랜치 미기록이라 default 조회).
    // F6: 조회 실패·빈 값이면 'main' 추측 대신 명시 에러(엉뚱한 base로 PR 여는 것 방지).
    let base: string;
    if (earlyBase !== undefined) {
      base = earlyBase;
    } else {
      const read = await this.ghDefaultBranch(worktreePath, ghRepo);
      if (!read.ok) {
        return { ok: false, reason: 'pr-failed', error: `Could not determine the base branch (repo default): ${read.error}` };
      }
      base = read.base;
    }
    if (!base) {
      return { ok: false, reason: 'pr-failed', error: 'Could not determine the base branch (empty response) — origin has no defaultBranchRef.' };
    }

    // ── ④ gh pr create --head --title --body --base ──
    let prUrl = '';
    try {
      const { stdout } = await this.gh(
        ['pr', 'create', ...(ghRepo ? ['-R', ghRepo] : []), '--head', branch, '--base', base, '--title', title, '--body', body],
        worktreePath,
      );
      prUrl = extractPrUrl(stdout, forgeHosts().gh);
    } catch (createErr) {
      // 멱등 재진입(CX5+G4): 기존 PR을 조회해 URL 회수로 수렴.
      const recovered = await this.recoverExistingPr(worktreePath, branch, ghRepo);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return { ok: false, reason: 'pr-failed', error: `gh pr create failed: ${errMsg(createErr)}` };
    }

    if (!prUrl || !isGithubPullUrl(prUrl, forgeHosts().gh)) {
      // 출력 파싱 실패 — 재진입 조회로 URL 회수 시도.
      const recovered = await this.recoverExistingPr(worktreePath, branch, ghRepo);
      if (recovered) {
        return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, recovered, true);
      }
      return {
        ok: false,
        reason: 'pr-failed',
        error: `The PR was created but its URL could not be parsed: ${prUrl || '(empty output)'}`,
      };
    }

    return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, prUrl, false);
  }

  /** The repo default branch as gh reads it (`''` when it has none), of
   *  `repo` when named, else the repository gh picks from the remotes. */
  private async ghDefaultBranch(worktreePath: string, repo?: string): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
    try {
      const { stdout } = await this.gh(
        ['repo', 'view', ...(repo ? [repo] : []), '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
        worktreePath,
      );
      return { ok: true, base: stdout.trim() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  /** A refusal when `branch` is not a plain branch name: a refspec character
   *  (`git push origin -- +x` force-pushes), a leading `-`, or a name git
   *  does not hand back unchanged (`@{-1}` expands). Null when it is fine. */
  private async branchRefusal(worktreePath: string, branch: string): Promise<CreatePrResult | null> {
    const refusal: CreatePrResult = { ok: false, reason: 'error', error: `Not a plain branch name: ${JSON.stringify(branch)} — nothing was pushed.` };
    if (!branch || branch.startsWith('-') || branch.startsWith('refs/') || /[:+^~]|@\{/.test(branch)) return refusal;
    try {
      const { stdout } = await this.git(['check-ref-format', '--branch', branch], worktreePath);
      return stdout.trim() === branch ? null : refusal;
    } catch {
      return refusal;
    }
  }

  /** origin's push remote key (`host/…/project`, lowercased), or null: the
   *  push and the merge request name the same project. */
  private async originKey(worktreePath: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(['remote', 'get-url', '--push', 'origin'], worktreePath);
      return parseRemoteKey(stdout);
    } catch {
      return null;
    }
  }

  /** The glab gate: installed, then signed in on origin's host. Only glab's
   *  own 401 / "Unauthenticated." is a sign-out; a host that did not answer
   *  is transient and says so. Null when glab may go on. */
  private async glabGate(worktreePath: string, key: string, branch: string): Promise<CreatePrResult | null> {
    const host = key.split('/')[0];
    try {
      await this.exec(process.platform === 'win32' ? 'glab.exe' : 'glab', ['--version'], {
        cwd: worktreePath,
        timeout: GH_TIMEOUT_MS,
        env: GLAB_ENV,
        windowsHide: true,
      });
    } catch {
      return {
        ok: false,
        reason: 'gh-missing',
        error: 'GitLab CLI (glab) is not installed.',
        browseFallback: `Or push the branch ${branch} and open the merge request in GitLab in the browser`,
      };
    }
    const login = await this.glab.loginOrSignOut(host, worktreePath);
    if (login && 'signedOut' in login) {
      return {
        ok: false,
        reason: 'gh-unauth',
        error: `GitLab CLI is not signed in to ${host} — run \`${glabLoginHint(host)}\` and try again.`,
        browseFallback: `Or open the merge request for the branch ${branch} in GitLab in the browser`,
      };
    }
    if (!login) {
      return { ok: false, reason: 'error', error: `GitLab on ${host} could not be reached just now — try again.` };
    }
    return null;
  }

  /** The GitLab path, after glabGate: createPr's steps with glab, inside
   *  origin's project. */
  private async createMr(input: CreatePrInput, key: string, body: string, target: string): Promise<CreatePrResult> {
    const { taskId, verifiedWorkspaceId, worktreePath, branch, title } = input;
    const host = key.split('/')[0];

    // ── ② dirty 검사(CX7) — as on the gh path.
    try {
      const { stdout } = await this.git(['status', '--porcelain'], worktreePath);
      if (stdout.trim().length > 0) {
        return {
          ok: false,
          reason: 'dirty',
          error: 'The worktree has uncommitted changes — they would not be in the merge request. Commit them first.',
        };
      }
    } catch (err) {
      return { ok: false, reason: 'error', error: `git status failed: ${errMsg(err)}` };
    }

    // ── ③ push — the gh path's push (origin was read above).
    const movedBeforePush = await this.pushTargetMoved(worktreePath, target);
    if (movedBeforePush) return movedBeforePush;
    const secrets = await this.secretsRefusal(worktreePath, branch);
    if (secrets) return secrets;
    try {
      await this.git(['push', '-u', 'origin', '--', branch], worktreePath);
    } catch (err) {
      return { ok: false, reason: 'push-failed', error: `git push failed: ${errMsg(err)}` };
    }

    // base = the project's default branch; unreadable is an error, never a guess.
    const base = await this.glab.defaultBranch(worktreePath, key);
    if (!base.ok) {
      return { ok: false, reason: 'pr-failed', error: `Could not determine the base branch (project default): ${base.message}` };
    }

    // ── ④ the merge request, then re-entry: an open MR for this source → target.
    const created = await this.glab.createMergeRequest(worktreePath, key, { source: branch, target: base.value, title, description: body });
    if (created.ok) {
      return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, created.url, false, created.iid);
    }
    const existing = await this.glab.openMergeRequestOf(worktreePath, key, branch, base.value);
    if (existing) {
      return this.finalize(taskId, verifiedWorkspaceId, worktreePath, branch, existing.url, true, existing.iid);
    }
    if (created.signedOut) {
      return {
        ok: false,
        reason: 'gh-unauth',
        error: `GitLab CLI is not signed in to ${host} — run \`${glabLoginHint(host)}\` and try again.`,
      };
    }
    return { ok: false, reason: 'pr-failed', error: `Opening the merge request failed: ${created.message}` };
  }

  /** 기존 PR URL 조회(멱등 재진입). 없으면 null. */
  private async recoverExistingPr(worktreePath: string, branch: string, repo?: string): Promise<string | null> {
    try {
      const { stdout } = await this.gh(
        ['pr', 'list', ...(repo ? ['-R', repo] : []), '--head', branch, '--state', 'all', '--json', 'url', '--jq', '.[0].url'],
        worktreePath,
      );
      const url = stdout.trim();
      return url.length > 0 && isGithubPullUrl(url, forgeHosts().gh) ? url : null;
    } catch {
      return null;
    }
  }

  /** prUrl 커밋(데몬) + PrStatusCache invalidate. 커밋 실패는 비치명(commitPending). */
  private async finalize(
    taskId: string,
    verifiedWorkspaceId: string,
    worktreePath: string,
    branch: string,
    prUrl: string,
    recovered: boolean,
    mrIid?: number,
  ): Promise<CreatePrResult> {
    let commitPending = false;
    try {
      // A PR page off github.com was accepted on a host gh is signed in to
      // (isGithubPullUrl); the daemon takes that host from here.
      const gheHost = mrIid === undefined && !WORKTASK_PR_URL_RE.test(prUrl) ? githubPullUrlHost(prUrl) ?? '' : '';
      const res = (await this.daemon.rpc('task.mission.update', {
        taskId,
        verifiedWorkspaceId,
        prUrl,
        ...(gheHost ? { prUrlGithubHost: gheHost } : {}),
      })) as { ok?: boolean };
      if (!res || res.ok !== true) commitPending = true;
    } catch {
      commitPending = true;
    }
    // CX8: PR 생성 성공 → 5분 TTL 캐시 무효화(다음 폴이 새 PR 상태를 즉시 반영).
    try {
      this.cache?.invalidate(worktreePath, branch);
    } catch {
      /* 캐시 무효화 실패는 무해 — 다음 TTL 만료가 수렴 */
    }
    return {
      ok: true,
      prUrl,
      ...(recovered ? { recovered: true } : {}),
      ...(commitPending ? { commitPending: true } : {}),
      ...(mrIid !== undefined ? { mrIid } : {}),
    };
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string };
    const stderr = typeof withStderr.stderr === 'string' ? withStderr.stderr.trim() : '';
    return stderr.length > 0 ? stderr.slice(0, 300) : err.message;
  }
  return String(err);
}

/** The PR URL in `gh pr create`'s stdout: the last pull request URL on
 *  github.com or on a host gh is signed in to (GitHub Enterprise). */
function extractPrUrl(stdout: string, githubHosts: ReadonlySet<string>): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/https:\/\/[\w.-]+(?::\d{1,5})?\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
    if (m && isGithubPullUrl(m[0], githubHosts)) return m[0];
  }
  return '';
}
