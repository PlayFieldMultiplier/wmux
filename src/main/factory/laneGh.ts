// ─── The merge lane's GitHub and store ports ─────────────────────────────────
//
// What mergeLaneHost hands its executor and host: the effect store (one
// instance per data dir), the fresh lane read (GhPrReviewService's
// LANE_PR_QUERY, never the TTL cache), the squash merge of an effect, the
// login gh signs in as now, and a PR's author workspaces.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { getWmuxDir } from '../../daemon/config';
import type { DaemonClient } from '../DaemonClient';
import type { MergeEffect } from '../../shared/moaDecision';
import type { PrWriteResult } from '../../shared/prReview';
import { ghPrReviewService } from '../github/GhPrReviewService';
import { ghIssueEnv, splitRepoKey } from '../github/GhIssueService';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { authorWorkspaces, parseWorktreeList } from '../deck/authorWorkspaces';
import { MoaEffectStore } from '../deck/moaEffectStore';
import { moaMergeSubject } from '../deck/moaMergeFacts';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GH_TIMEOUT_MS = 15_000;
const gh = process.platform === 'win32' ? 'gh.exe' : 'gh';

/** The effect store for a data dir, built once: two instances of one store
 *  would each write their own map over the file. Throws on a corrupt store. */
let effectStore: { dir: string; effects: MoaEffectStore } | null = null;
export function laneEffectStore(dir: string = getWmuxDir()): MoaEffectStore {
  if (!effectStore || effectStore.dir !== dir) effectStore = { dir, effects: new MoaEffectStore(dir) };
  return effectStore.effects;
}

/** The login gh signs in as on the repo's host now: never cached, so an
 *  account switch stops the next merge. */
export async function currentGhLogin(repo: { key: string; path: string }): Promise<string | null> {
  const parts = splitRepoKey(repo.key);
  if (!parts) return null;
  try {
    const { stdout } = await execFileAsync(gh, ['api', '--hostname', parts.host, 'user', '--jq', '.login'], {
      cwd: repo.path, timeout: GH_TIMEOUT_MS, env: ghIssueEnv(), windowsHide: true,
    });
    return stdout.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The PR's author workspaces (authorWorkspaces.ts). Throws when unknown. */
export function prAuthorWorkspaces(getDaemonClient: () => DaemonClient | null, asker: { workspaceId: string }, repoPath: string, headRefName: string): Promise<string[]> {
  return authorWorkspaces({
    listLedger: () => getTaskLedger().list({}),
    daemonRpc: () => {
      const dc = getDaemonClient();
      return dc?.isConnected ? (method, params) => dc.rpc(method, params) : null;
    },
    worktrees: async (cwd) => {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
      return parseWorktreeList(stdout);
    },
    workspaceIds: () => getWorkspaceMirror().getEntries()?.map((e) => e.id) ?? null,
    paneCwds: () => {
      const mirror = getWorkspaceMirror();
      const entries = mirror.getEntries();
      if (!entries) return null;
      return entries.flatMap((e) => (mirror.getFleetSnapshot(e.id)?.panes ?? []).map((p) => ({ workspaceId: e.id, cwd: p.cwd ?? '' })));
    },
    realpath: (p) => {
      try { return fs.realpathSync(p); } catch { return p; }
    },
  }, { askerWorkspaceId: asker.workspaceId, repoPath, headRefName });
}

/** The lane read: GhPrReviewService's LANE_PR_QUERY, never the TTL cache. */
export const freshLaneFacts = {
  readFresh: async (repoPath: string, key: string, n: number) => {
    const r = await ghPrReviewService.laneFacts(repoPath, key, n);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  },
};

/** The squash merge of an effect, with the subject GitHub would give it. */
export async function squashMergeEffect(e: MergeEffect): Promise<PrWriteResult> {
  // The subject GitHub would give a squash: the title and the number.
  const head = await ghPrReviewService.checks(e.repoPath, e.repoKey, e.prNumber, true);
  return ghPrReviewService.merge(e.repoPath, e.repoKey, e.prNumber, {
    expectHead: e.expectHead, subject: moaMergeSubject(head.ok ? head.value.head.title : '', e.prNumber), body: '',
  });
}
