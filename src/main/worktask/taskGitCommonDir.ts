// ─── The git dir main runs task_push and task_fetch on ─────────────────────
//
// Main's record, never the worktree: the common git dir FanOutService wrote
// on the task's ledger row at dispatch (LedgerDispatch.gitCommonDir). A bot's
// task from before that field existed uses the repository folder of the
// bot's profile, set by the owner. Any other task without the record has
// none.

import fs from 'node:fs';
import path from 'node:path';
import type { LedgerDispatch } from '../../shared/ledger';
import { defaultGit, type TaskPushGit } from './taskPush';

/** The task's recorded common git dir, or null. Never throws. */
export async function recordedTaskGitCommonDir(
  dispatch: LedgerDispatch | undefined,
  botRepoPath: (botId: string) => string | undefined,
  git: TaskPushGit = defaultGit,
): Promise<string | null> {
  if (dispatch?.gitCommonDir) return dispatch.gitCommonDir;
  const botId = dispatch?.origin.kind === 'bot' ? dispatch.origin.botId : undefined;
  const repoPath = botId ? botRepoPath(botId) : undefined;
  if (!repoPath || !path.isAbsolute(repoPath)) return null;
  const r = await git(['rev-parse', '--git-common-dir'], repoPath);
  const out = r.code === 0 ? r.stdout.trim() : '';
  if (!out) return null;
  try {
    return fs.realpathSync.native(path.resolve(repoPath, out));
  } catch {
    return null;
  }
}
