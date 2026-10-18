/**
 * TaskCloseService — 태스크 close 오케스트레이션(J3 §1, main측).
 *
 * 순서 계약(리뷰 CX1·CX2·G2 — v1 "close 먼저"의 역전):
 *   ⓪ upstream/ahead 검사 — 미push 커밋이 있으면 close를 진행하지 않고 경고
 *      반환(CX3: porcelain-clean ≠ 수확 완료. PR 제안은 호출측 UI 몫).
 *   ① worktree remove — TaskWorktreeManager.removeWorktree(내부 porcelain
 *      재검사가 dirty 정본 게이트 — G1 TOCTOU는 remove 내부 검사로 흡수).
 *      dirty면 remove 거부 + **close도 보류**(태스크 open 유지 — "닫혔는데
 *      산출물 잔존" 모순 제거) + 보존 목록 등재.
 *   ② remove 성공 후에만 mission.close(데몬 RPC). archive 실패는 데몬이
 *      삼키고 부트 reconcile이 수렴하므로 여기선 결과만 전달.
 *   ③ meta dir(prompt.md) 삭제 — 태스크 종료 후 재발사 무의미(§1).
 *
 * ②↔③ 사이 크래시 = closed 태스크 + meta 잔존 → 정리 스캔(디스크 정본) 몫.
 * ①↔② 사이 크래시 = open 태스크 + worktree 없음 = 미물질화형 잔여 → 동일.
 *
 * 미물질화 태스크(worktreePath 부재 — CX4): worktree 단계를 건너뛰고 close만.
 * 호출측 UI가 회수 확인 다이얼로그를 선행한다(여기선 플래그로만 표시).
 */

import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TaskWorktreeManager } from './TaskWorktreeManager';
import { noteWorkTaskClosed } from '../deck/taskLedgerHost';
import { getExecEnv } from '../../shared/execEnv';

const execFileAsync = promisify(execFile);

/** 데몬 RPC 최소 표면(FanOutDaemonPort 동형 — 테스트 주입 가능). */
export interface CloseDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CloseTaskInput {
  taskId: string;
  verifiedWorkspaceId: string;
  /** 물질화 정보(데몬 projection에서 조회한 값 — 부재면 미물질화 close). */
  repoRoot?: string;
  repoHash?: string;
  worktreePath?: string;
  metaDir?: string;
  /** A close-only task's folder that is still on disk but no longer a
   *  worktree (#2388): a removal recorded as pending there is finished
   *  before the task closes, and the task stays open when it cannot be. */
  leftoverPath?: string;
  /** Close and keep folder (#2388): close the task and leave its folder on
   *  disk as it is, with nothing checked, stopped or removed. The way out
   *  of a close that keeps refusing. The folder is `worktreePath`, or
   *  `leftoverPath`. */
  keepFolder?: boolean;
}

export type CloseTaskResult =
  /** `keptFolder`: the task closed and this folder stays on disk. */
  | { ok: true; taskId: string; archivePending: boolean; unmaterialized?: boolean; keptFolder?: string }
  | {
      ok: false;
      taskId: string;
      /** 'unpushed' = 미push 커밋 경고(진행 안 함) / 'dirty' = 보존 + close 보류 / 'error' = 기타 */
      reason: 'unpushed' | 'dirty' | 'error';
      error: string;
      /** dirty 보존 시 등재 경로. */
      preservedWorktree?: string;
      /** unpushed 시 ahead 커밋 수(경고 표시용). */
      aheadCount?: number;
    };

export interface TaskCloseServiceOptions {
  daemon: CloseDaemonPort;
  worktrees: TaskWorktreeManager;
  /** Stops the panes running inside the worktree; called only after the unpushed and dirty checks pass.
   *  Answers the sessions it stopped, when it knows them. */
  stopPanesIn?: (worktreePath: string) => Promise<void | string[]>;
  /** The task closed after its worktree's panes were stopped (`sessionIds`):
   *  its agent is gone (agentGoneFacts.ts). Not called for a close-only
   *  task, whose panes nothing stopped. */
  panesStopped?: (taskId: string, sessionIds: string[]) => void;
  /** Removes the task's relay repository (task_push/task_fetch); called on every close. */
  removeRelay?: (taskId: string) => void | Promise<void>;
  /** The commit task_push last published for the task (main's record), or
   *  null: a worktree whose HEAD is that commit counts as pushed. */
  pushedHead?: (taskId: string) => string | null;
  /** Close and keep folder: forget what earlier stops of the folder left. */
  forgetStops?: (folder: string) => void;
  /** Close and keep folder of a bot's task: hold its folder against the
   *  bots' task folder cleanup (waiting for one under way), and mark it
   *  kept once the task closed (holdTaskFolder, noteTaskFolderKept). */
  holdTaskFolder?: (taskId: string) => Promise<() => void>;
  noteFolderKept?: (taskId: string) => void;
}

export class TaskCloseService {
  private readonly daemon: CloseDaemonPort;
  private readonly worktrees: TaskWorktreeManager;
  private readonly stopPanesIn?: (worktreePath: string) => Promise<void | string[]>;
  private readonly panesStopped?: (taskId: string, sessionIds: string[]) => void;
  private readonly removeRelay?: (taskId: string) => void | Promise<void>;
  private readonly pushedHead?: (taskId: string) => string | null;
  private readonly forgetStops?: (folder: string) => void;
  private readonly holdTaskFolder?: (taskId: string) => Promise<() => void>;
  private readonly noteFolderKept?: (taskId: string) => void;

  constructor(opts: TaskCloseServiceOptions) {
    this.forgetStops = opts.forgetStops;
    this.holdTaskFolder = opts.holdTaskFolder;
    this.noteFolderKept = opts.noteFolderKept;
    this.daemon = opts.daemon;
    this.worktrees = opts.worktrees;
    this.stopPanesIn = opts.stopPanesIn;
    this.panesStopped = opts.panesStopped;
    this.removeRelay = opts.removeRelay;
    this.pushedHead = opts.pushedHead;
  }

  /** The close running for each task. */
  private readonly closing = new Map<string, Promise<CloseTaskResult>>();
  /** Tasks this process closed keeping their folder: a later close of one
   *  (queued behind the keep, from its stale view) removes nothing. */
  private readonly kept = new Set<string>();

  /**
   * Close a task. Closes of one task run one at a time (#2388): a Close and
   * keep folder asked while a close that removes the worktree runs would
   * otherwise race it, and the removal deletes what the keep promised to
   * leave. One asked meanwhile starts once the earlier one is over.
   */
  closeTask(input: CloseTaskInput): Promise<CloseTaskResult> {
    const prev = this.closing.get(input.taskId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.closeTaskNow(input));
    this.closing.set(input.taskId, run);
    void run.finally(() => {
      if (this.closing.get(input.taskId) === run) this.closing.delete(input.taskId);
    }).catch(() => undefined);
    return run;
  }

  private async closeTaskNow(input: CloseTaskInput): Promise<CloseTaskResult> {
    const { taskId } = input;
    const named = input.worktreePath ?? input.leftoverPath;

    // Closed keeping its folder: the folder is the owner's, and a close asked
    // since (queued behind that one) removes nothing.
    if (this.kept.has(taskId) && !input.keepFolder) {
      return { ok: true, taskId, archivePending: false, ...(named && fs.existsSync(named) ? { keptFolder: named } : {}) };
    }

    // Close and keep folder, or a close of a folder it was chosen for whose
    // close did not finish: the keep way.
    if (input.keepFolder || (named && this.worktrees.pendingRemovalKept(named))) {
      return this.keepClose(input);
    }

    return this.closeNow(input);
  }

  /**
   * Close and keep folder: the task closes, the folder stays as it is. It
   * closes detached: the folder is the owner's from now on, so nothing that
   * cleans up after closed tasks (the bots' task folder cleanup, the cleanup
   * list's orphan check) takes it.
   */
  private async keepClose(input: CloseTaskInput): Promise<CloseTaskResult> {
    const { taskId } = input;
    const folder = input.worktreePath ?? input.leftoverPath;
    // Held from the start: a finish of it under way (the sweep at start)
    // must not delete it. Its pending removal is marked kept on disk
    // BEFORE the task closes, and ends only once the close is confirmed:
    // no restart finds a removal that could delete it, and a close that
    // failed is taken the keep way again. When the mark cannot be written,
    // the task stays open.
    let release: () => void = () => undefined;
    let releaseTask: () => void = () => undefined;
    try {
      // A bot's task: its folder cleanup (one under way is waited for)
      // leaves the folder alone from here on, whichever folder it is.
      if (this.holdTaskFolder) releaseTask = await this.holdTaskFolder(taskId);
      if (folder) {
        release = this.worktrees.holdFolder(folder);
        await this.worktrees.markPendingRemovalKept(folder);
      }
      const closed = await this.missionClose(taskId, input.verifiedWorkspaceId, { detach: true });
      if (!closed.ok) return { ok: false, taskId, reason: 'error', error: closed.error };
      // The daemon records a detach only on an open task: one closed before
      // has nothing that keeps its folder from the cleanups after a restart.
      if (!closed.detached) {
        return {
          ok: false,
          taskId,
          reason: 'error',
          error: 'close: the task was already closed, so its folder cannot be marked kept; it stays where it is, but the cleanup of closed tasks may still take it',
        };
      }
      this.kept.add(taskId);
      try {
        this.noteFolderKept?.(taskId);
      } catch {
        // The detached mission still keeps it from every later pass.
      }
      if (folder) {
        this.forgetFolderStops(folder);
        await this.worktrees.forgetPendingRemoval(folder).catch((err: unknown) => {
          // Still marked kept: it deletes nothing, and a later close of the
          // task ends it.
          console.warn(`[worktask] the kept folder ${folder} stays recorded: ${(err as Error).message}`);
        });
      }
      // A finish that was already deleting it when this was chosen (it
      // deletes only a folder that holds nothing but what git left) leaves
      // nothing to name.
      return { ok: true, taskId, archivePending: closed.archivePending, ...(folder && fs.existsSync(folder) ? { keptFolder: folder } : {}) };
    } catch (err) {
      return { ok: false, taskId, reason: 'error', error: (err as Error).message };
    } finally {
      releaseTask();
      release();
    }
  }

  private async closeNow(input: CloseTaskInput): Promise<CloseTaskResult> {
    const { taskId } = input;
    // 미물질화 close(CX4): worktree 단계 전체 건너뜀 — close만 커밋.
    if (!input.worktreePath) {
      // #2388: a folder an earlier close left half removed is finished first.
      const stopped: { ids: string[] | null } = { ids: null };
      const stopPanesIn = this.stopPanesIn;
      const finished = input.leftoverPath
        ? await this.worktrees.finishPendingRemoval(
          input.leftoverPath,
          stopPanesIn
            ? async (folder) => {
              const ids = await stopPanesIn(folder);
              stopped.ids = Array.isArray(ids) ? ids : null;
            }
            : undefined,
          // Its repository gone, the folder can never be checked again: the
          // task closes, and the folder stays (named in the result).
          { keepWhenRepoGone: true },
        )
        : null;
      if (finished && !finished.ok) {
        return { ok: false, taskId, reason: finished.dirty ? 'dirty' : 'error', error: finished.error, preservedWorktree: input.leftoverPath };
      }
      // Its repository gone, the folder is marked kept: the task closes the
      // keep way.
      if (finished?.ok && finished.keptFolder) return this.keepClose({ ...input, keepFolder: true });
      const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
      if (!closed.ok) return { ok: false, taskId, reason: 'error', error: closed.error };
      if (stopped.ids) {
        try {
          this.panesStopped?.(taskId, stopped.ids);
        } catch {
          // Best effort: the next liveness read records it.
        }
      }
      return {
        ok: true,
        taskId,
        archivePending: closed.archivePending,
        unmaterialized: true,
      };
    }

    // ⓪ upstream/ahead 검사(CX3): 커밋됐지만 push 안 된 산출물이 있으면 진행 중단.
    // task_push sets no upstream: a HEAD that is the commit it last published counts as pushed.
    const ahead = (await this.headIsPushed(taskId, input.worktreePath)) ? { kind: 'clean' as const } : await this.aheadOfUpstream(input.worktreePath);
    if (ahead.kind === 'ahead') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: ${ahead.count} commit(s) are not pushed — open a PR or push, then close again.`,
        aheadCount: ahead.count,
      };
    }
    // upstream 부재 + 로컬 커밋 존재(fan-out 직후 base에서 전진) — 동일하게 경고.
    if (ahead.kind === 'no-upstream-with-commits') {
      return {
        ok: false,
        taskId,
        reason: 'unpushed',
        error: `close: the branch has ${ahead.count} commit(s) that were never pushed — open a PR or push, then close again.`,
        aheadCount: ahead.count,
      };
    }

    // ① worktree remove — 내부 porcelain 재검사가 dirty 정본 게이트(G1).
    if (!input.repoRoot || !input.repoHash) {
      return { ok: false, taskId, reason: 'error', error: 'close: the task is missing repoRoot/repoHash (incomplete worktree record).' };
    }
    const stopped: { ids: string[] | null } = { ids: null };
    const stopPanesIn = this.stopPanesIn;
    const removed = await this.worktrees.removeWorktree(
      input.repoRoot,
      input.repoHash,
      input.worktreePath,
      stopPanesIn
        ? async (worktreePath) => {
          const ids = await stopPanesIn(worktreePath);
          stopped.ids = Array.isArray(ids) ? ids : null;
        }
        : undefined,
    );
    if (!removed.ok) {
      if (removed.preserved) {
        // dirty 보존 — close 보류(태스크 open 유지, §1 계약).
        // A failed status check is preserved too, but it is not known to be
        // dirty: report it as an error so callers do not suggest discarding
        // changes that may not exist.
        return {
          ok: false,
          taskId,
          reason: removed.dirty ? 'dirty' : 'error',
          error: removed.error,
          preservedWorktree: input.worktreePath,
        };
      }
      return { ok: false, taskId, reason: 'error', error: removed.error };
    }

    // ② remove 성공 후에만 close 커밋.
    const closed = await this.missionClose(taskId, input.verifiedWorkspaceId);
    if (!closed.ok) {
      // remove는 이미 성립(clean이었으므로 산출물 유실 없음) — close 실패는
      // open+worktree 없음 상태로 남고 재시도 가능. 명시 에러.
      return { ok: false, taskId, reason: 'error', error: closed.error };
    }
    if (stopped.ids) {
      try {
        this.panesStopped?.(taskId, stopped.ids);
      } catch {
        // Best effort: the next liveness read records it.
      }
    }

    // ③ meta dir(prompt.md) 삭제 — 실패는 비치명(정리 스캔 몫), 결과에 무영향.
    if (input.metaDir) {
      try {
        fs.rmSync(input.metaDir, { recursive: true, force: true });
      } catch {
        /* 정리 스캔이 줍는다 */
      }
    }

    return { ok: true, taskId, archivePending: closed.archivePending };
  }

  /** A folder that stays: what earlier stops of it left is not checked again. */
  private forgetFolderStops(folder: string): void {
    try {
      this.forgetStops?.(folder);
    } catch {
      // Best effort: only a later stop of the same folder reads it.
    }
  }

  /** mission.close 데몬 RPC — archive 실패 여부(archivePending)를 결과에 전달(CX2). */
  private async missionClose(
    taskId: string,
    verifiedWorkspaceId: string,
    opts: { detach?: boolean } = {},
  ): Promise<{ ok: true; archivePending: boolean; detached: boolean } | { ok: false; error: string }> {
    try {
      const res = (await this.daemon.rpc('task.mission.close', {
        taskId,
        verifiedWorkspaceId,
        ...(opts.detach ? { detach: true } : {}),
      })) as { ok?: boolean; archivePending?: boolean; detached?: boolean; error?: { message?: string } };
      if (res && res.ok === true) {
        // Lane F: the task ledger learns about the close now, not on the
        // next reconcile pass (an open row would hold the brain's Stop gate).
        await noteWorkTaskClosed(taskId);
        // Queued, not awaited: the removal waits behind any relay call in
        // flight (up to TASK_PUSH_TIMEOUT_MS per git call), longer than the
        // caller's RPC timeout.
        try {
          void Promise.resolve(this.removeRelay?.(taskId)).catch(() => undefined);
        } catch {
          // Best-effort: a leftover relay is swept at the next start.
        }
        return { ok: true, archivePending: res.archivePending === true, detached: res.detached === true };
      }
      return { ok: false, error: res?.error?.message ?? 'task.mission.close failed' };
    } catch (err) {
      return { ok: false, error: `task.mission.close: ${(err as Error).message}` };
    }
  }

  /**
   * upstream 대비 ahead 커밋 검사(CX3). 판정 3종:
   *   - upstream 존재: `rev-list --count @{upstream}..HEAD` > 0 → ahead
   *   - upstream 부재: fan-out base(머지베이스 추적 불가) 대신 브랜치 자체 커밋
   *     여부 — `rev-list --count HEAD ^--remotes` 근사 대신 안전하게
   *     `rev-list --count HEAD --not --remotes`로 원격 어디에도 없는 커밋 수.
   *   - 검사 실패: 보수적으로 통과(clean 판정은 remove의 porcelain이 정본 —
   *     여기는 경고 게이트라 fail-open이 UX 손실뿐 데이터 손실 없음).
   */
  /** Whether the worktree's HEAD is the commit task_push last published. */
  private async headIsPushed(taskId: string, worktreePath: string): Promise<boolean> {
    const pushed = this.pushedHead?.(taskId);
    if (!pushed) return false;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: worktreePath, timeout: 15000, env: getExecEnv() });
      return stdout.trim().toLowerCase() === pushed.toLowerCase();
    } catch {
      return false;
    }
  }

  private async aheadOfUpstream(
    worktreePath: string,
  ): Promise<{ kind: 'clean' } | { kind: 'ahead' | 'no-upstream-with-commits'; count: number }> {
    try {
      const upstream = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
      ).then(
        () => true,
        () => false,
      );
      if (upstream) {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', '@{upstream}..HEAD'],
          { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
        );
        const n = parseInt(stdout.trim(), 10);
        return n > 0 ? { kind: 'ahead', count: n } : { kind: 'clean' };
      }
      // 원격이 아예 없는 로컬 전용 repo면 push 개념이 없다 — 경고 생략(오탐 방지).
      const remotes = await execFileAsync('git', ['remote'], { cwd: worktreePath, timeout: 15000, env: getExecEnv() });
      if (remotes.stdout.trim().length === 0) return { kind: 'clean' };
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath, timeout: 15000, env: getExecEnv() },
      );
      const n = parseInt(stdout.trim(), 10);
      return n > 0 ? { kind: 'no-upstream-with-commits', count: n } : { kind: 'clean' };
    } catch {
      return { kind: 'clean' };
    }
  }
}
