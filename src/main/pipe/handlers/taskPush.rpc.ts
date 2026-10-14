// ─── task.push — a fan-out worker publishes its own task branch ─────────────
//
// The caller is a worker pane: its senderPtyId resolves (main's mirror) to its
// task workspace, whose open ledger row names the task, and the WorkTask main
// created names the worktree and the branch. Nothing about the push comes
// from the wire; the push itself is main/worktask/taskPush.ts.
//
// Refused for a commander (brain) or a bot token — they own tasks, they are
// not a task's worker — and for a task on a detached checkout (verify).

import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { getWmuxDir } from '../../../daemon/config';
import { readBotWorkerDefaultBranches } from '../../../shared/botWorkerGuard';
import { readRepoDefaultBranch } from '../../agents/botWorkerDefaultBranch';
import { pushTaskBranch, type TaskPushGit, type TaskPushResult } from '../../worktask/taskPush';

type GetWindow = () => BrowserWindow | null;

export interface TaskPushRpcDeps {
  getWindow: GetWindow;
  daemon: { rpc(method: string, params: Record<string, unknown>): Promise<unknown> };
  /** Injected in tests. */
  getLedger?: () => TaskLedger;
  resolveCallerWorkspace?: (senderPtyId: string) => Promise<string | null>;
  wmuxDir?: () => string;
  git?: TaskPushGit;
  push?: typeof pushTaskBranch;
  /** The repository's own default branch (GitHub's, else origin/HEAD). */
  repoDefaultBranch?: (worktreePath: string) => Promise<string | null>;
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

interface MissionTask { id: string; status?: string; branch?: string; worktreePath?: string; detachedAt?: number }

export function registerTaskPushRpc(router: RpcRouter, deps: TaskPushRpcDeps): void {
  const ledgerOf = deps.getLedger ?? getTaskLedger;
  const resolveCaller = deps.resolveCallerWorkspace ?? (async (pty: string) => {
    try {
      return await resolvePtyOwnerWorkspace(deps.getWindow, pty);
    } catch {
      return null;
    }
  });
  const push = deps.push ?? pushTaskBranch;

  router.register('task.push', async (params, ctx?: RpcContext) => {
    if (ctx?.origin !== 'local') return deny('NOT_AUTHORIZED', 'task.push is local-origin only');
    if (ctx?.commanderWorkspace || ctx?.bot) {
      return deny('NOT_AUTHORIZED', 'task.push: only a task\'s own worker pushes its branch');
    }
    const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'].trim() : '';
    const workspaceId = senderPtyId ? await resolveCaller(senderPtyId) : null;
    if (!workspaceId) return deny('NOT_AUTHORIZED', 'task.push: caller identity could not be resolved (no resolvable senderPtyId)');
    const row = ledgerOf().findOpenByTaskWorkspace(workspaceId);
    if (!row) return deny('NOT_FOUND', 'task.push: no open task belongs to your workspace');
    if (row.dispatch?.checkout) {
      return deny('FAILED_PRECONDITION', 'task.push: this task is a detached checkout of one commit; it has no branch to publish');
    }
    let listed: { ok?: boolean; tasks?: MissionTask[] } | undefined;
    try {
      listed = (await deps.daemon.rpc('task.mission.list', { verifiedWorkspaceId: row.ownerWorkspaceId })) as typeof listed;
    } catch (err) {
      return deny('UNAVAILABLE', `task.push: could not read the task record: ${err instanceof Error ? err.message : String(err)}`);
    }
    const task = Array.isArray(listed?.tasks) ? listed.tasks.find((t) => t.id === row.id) : undefined;
    if (!task || task.status !== 'open' || task.detachedAt !== undefined) {
      return deny('FAILED_PRECONDITION', 'task.push: the task is not open');
    }
    if (!task.branch || !task.worktreePath) {
      return deny('FAILED_PRECONDITION', 'task.push: the task has no worktree branch to publish');
    }
    const dir = (deps.wmuxDir ?? getWmuxDir)();
    // Every task, bot or not: the repository's own default branch is read
    // here (a task branch can be named by a person), next to the ones main
    // recorded for bots.
    const own = await (deps.repoDefaultBranch ?? ((p: string) => readRepoDefaultBranch(p)))(task.worktreePath).catch(() => null);
    const result: TaskPushResult = await push({
      worktreePath: task.worktreePath,
      branch: task.branch,
      defaultBranches: [...readBotWorkerDefaultBranches(dir), ...(own ? [own] : [])],
      noHooksDir: path.join(dir, 'factory', 'no-hooks'),
    }, ...(deps.git ? [deps.git] : []));
    return { ...result, taskId: row.id };
  });
}
