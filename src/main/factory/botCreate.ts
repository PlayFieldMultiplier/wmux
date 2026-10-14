// ─── Bots the owner adds ───────────────────────────────────────────────────
//
// `createBotFromFolder` is "Add bot" (the Bots page, Settings › Factory): a
// workspace and a name, optionally a picture, a job and the template that
// prefilled it, and a folder. Any number of bots, of any template, may share
// a workspace. The repository is optional: a workspace works on one
// repository, so when one of its bots already has a repo a new bot there
// takes that repo without a folder, and a folder naming another repository
// is refused (`repo_mismatch`); otherwise a folder becomes the bot's repo as
// fan-out needs it: the git root, realpath'd (fanout.rpc.ts refuses any
// other repoPath), keyed by its `origin` remote read now (never a cached
// answer, so adding a remote and retrying works). Without either, the bot
// has no repository yet. The profile itself goes through BotStore.create,
// the same validation and defaults as `bot.create`. `suggestBotRepo` is what
// "Add bot" offers before that: the sibling's repo, else the workspace's
// current folder as main itself tracks it (the active pane's shell cwd),
// resolved like a picked folder.
//
// A bot added here wakes once on its own (`greetNewBot`, wake reason
// `intro`): it greets the owner and asks what to do, with choices.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotProfile } from '../../shared/bot';
import type { FactoryBotCreateResult, FactoryBotRepoSuggestion } from '../../shared/botCreate';
import type { WakeItem } from '../../shared/wake';
import { normalizeRepoKey } from '../../shared/repoKey';
import { git as runGit, type GitResult } from '../git/git';
import { parseRemoteKey } from '../github/PrProvider';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import type { BotStore } from './botStore';
import type { WakeEnqueueInput } from './wakeQueue';

export interface BotRepoDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  realpath?: (p: string) => string;
}

export type BotRepoResult =
  | { ok: true; repo: { repoKey: string; repoPath: string } }
  | { ok: false; code: 'invalid_argument' | 'not_a_repo' | 'no_remote'; message: string };

/** The bot repo a picked folder names: its git root and origin's repo key. */
export async function resolveBotRepo(folder: unknown, deps: BotRepoDeps = {}): Promise<BotRepoResult> {
  if (typeof folder !== 'string' || folder.length === 0 || folder.length > 4096 || !path.isAbsolute(folder)) {
    return { ok: false, code: 'invalid_argument', message: 'Pick a repository folder.' };
  }
  const git = deps.git ?? runGit;
  const realpath = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const top = await git(['rev-parse', '--show-toplevel'], folder).catch(() => null);
  const root = top && top.code === 0 ? top.stdout.trim() : '';
  if (!root) return { ok: false, code: 'not_a_repo', message: `${folder} is not a git checkout.` };
  let repoPath = root;
  try {
    repoPath = realpath(root);
  } catch {
    /* kept as git printed it */
  }
  const remote = await git(['remote', 'get-url', 'origin'], repoPath).catch(() => null);
  const url = remote && remote.code === 0 ? remote.stdout.trim() : '';
  if (!url) return { ok: false, code: 'no_remote', message: `${repoPath} has no origin remote.` };
  const repoKey = normalizeRepoKey(parseRemoteKey(url));
  if (!repoKey) return { ok: false, code: 'no_remote', message: `The origin remote of ${repoPath} does not name an owner/repo repository.` };
  return { ok: true, repo: { repoKey, repoPath } };
}

/** The repo a workspace's bots already work on (its oldest repo bot's), or
 *  null when none has one. */
export function workspaceRepo(store: BotStore, workspaceId: unknown): { repoKey: string; repoPath: string } | null {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;
  const withRepo = store.list({ workspaceId }).filter((b) => b.repo).sort((a, b) => a.createdAt - b.createdAt);
  return withRepo[0]?.repo ? { ...withRepo[0].repo } : null;
}

/** One bot for "Add bot". */
export async function createBotFromFolder(
  store: BotStore | null,
  req: unknown,
  deps: BotRepoDeps = {},
): Promise<FactoryBotCreateResult> {
  if (!store) return { ok: false, code: 'not_started', message: 'The factory is not running.' };
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  let repo: { repoKey: string; repoPath: string } | undefined;
  if (r.repoFolder === undefined) {
    // No folder: the workspace's repo, when one of its bots has one.
    const inherited = workspaceRepo(store, r.workspaceId);
    if (inherited) repo = inherited;
  } else {
    const resolved = await resolveBotRepo(r.repoFolder, deps);
    if (!resolved.ok) return resolved;
    // Read after the await: a bot added meanwhile counts.
    const current = workspaceRepo(store, r.workspaceId);
    if (current && current.repoKey !== resolved.repo.repoKey) {
      return {
        ok: false,
        code: 'repo_mismatch',
        message: `This workspace's bots work on ${current.repoKey} (${current.repoPath}); ${resolved.repo.repoPath} is ${resolved.repo.repoKey}. A workspace works on one repository.`,
      };
    }
    repo = current ?? resolved.repo;
  }
  // The name, job, template, role and picture are checked by the store
  // (shared/bot.ts normalizeBotName / normalizeBotJob, botAvatar.ts), as on
  // every other write.
  const created = store.create({
    workspaceId: r.workspaceId,
    ...(r.template !== undefined ? { template: r.template } : {}),
    ...(r.role !== undefined ? { role: r.role } : {}),
    ...(repo ? { repo } : {}),
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.job !== undefined ? { job: r.job } : {}),
    ...(r.avatar !== undefined ? { avatar: r.avatar } : {}),
  });
  return created.ok ? { ok: true, bot: created.bot } : created;
}

/** Queue a new bot's first wake (`intro`: greet the owner, ask what to do
 *  with choices). Deduped by its reason key, so it runs once. Returns the
 *  item, or null when nothing was queued (no queue yet, bot disabled). */
export function greetNewBot(
  bot: Pick<BotProfile, 'id' | 'workspaceId' | 'enabled'>,
  enqueue: ((input: WakeEnqueueInput) => WakeItem | null) | null,
): WakeItem | null {
  if (!bot.enabled || !enqueue) return null;
  return enqueue({ botId: bot.id, workspaceId: bot.workspaceId, reason: { kind: 'intro' }, priority: 0 });
}

export interface BotRepoSuggestDeps extends BotRepoDeps {
  /** The workspaces as main's workspace mirror holds them (null: none pushed yet). */
  entries?: () => WorkspaceListEntry[] | null;
  /** A pane's shell cwd as main tracks it (OSC 7, the daemon, the spawn). */
  cwdOf?: (ptyId: string) => string | undefined;
  homeDir?: string;
}

/** The workspace's current folder as main tracks it: its active pane's shell
 *  cwd, else the first of its other panes that has one. Never a path the
 *  renderer sends with the request. */
export function workspaceFolder(
  workspaceId: string,
  entries: WorkspaceListEntry[] | null,
  cwdOf: (ptyId: string) => string | undefined,
): string | null {
  const entry = entries?.find((e) => e.id === workspaceId);
  if (!entry) return null;
  const ptys = [entry.activePtyId, ...(entry.ptyIds ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const ptyId of ptys) {
    const cwd = cwdOf(ptyId);
    if (cwd && path.isAbsolute(cwd)) return cwd;
  }
  return null;
}

/** `p` with the home folder shortened to `~`. */
export function homeShortPath(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** FACTORY_BOT_SUGGEST_REPO's answer: the repo "Add bot" offers a workspace. */
export async function suggestBotRepo(
  store: BotStore | null,
  workspaceId: unknown,
  deps: BotRepoSuggestDeps = {},
): Promise<FactoryBotRepoSuggestion> {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0 || workspaceId.length > 256) return { ok: false, code: 'invalid_argument' };
  const home = deps.homeDir ?? os.homedir();
  const inherited = store ? workspaceRepo(store, workspaceId) : null;
  if (inherited) {
    return { ok: true, repoKey: inherited.repoKey, root: inherited.repoPath, displayRoot: homeShortPath(inherited.repoPath, home), inherited: true };
  }
  const folder = workspaceFolder(workspaceId, deps.entries?.() ?? null, deps.cwdOf ?? (() => undefined));
  if (!folder) return { ok: false, code: 'no_folder' };
  const resolved = await resolveBotRepo(folder, deps);
  // Read after the await: a bot given a repo meanwhile is the workspace's repo.
  const since = store ? workspaceRepo(store, workspaceId) : null;
  if (since) return { ok: true, repoKey: since.repoKey, root: since.repoPath, displayRoot: homeShortPath(since.repoPath, home), inherited: true };
  if (!resolved.ok) return { ok: false, code: resolved.code === 'invalid_argument' ? 'no_folder' : resolved.code };
  const { repoKey, repoPath } = resolved.repo;
  return { ok: true, repoKey, root: repoPath, displayRoot: homeShortPath(repoPath, home), inherited: false };
}
