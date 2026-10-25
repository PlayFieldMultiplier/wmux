// The first run's last step: the bot its first task goes to (handoff #3).
//
// The folder is checked exactly as "Add bot" checks one (resolveBotRepo: a
// git checkout with a hosted owner/repo origin); nothing here widens what a
// bot may read. The bot is made once: it carries BotProfile.firstRun in the
// same record the store saves, so a second call, a re-run first run or a
// call after a quit finds it instead of making another. It is made
//   - only after the owner's plan consent (the wizard's "This task uses your
//     Claude usage" screen stores it, as Settings' Bots switch does),
//   - without its greeting turn (the first task is its first turn),
//   - with no worker slots (FIRST_RUN_BOT_WORKERS): a fan-out it asks for
//     waits for the owner to raise them, so nothing is pushed or opened as a
//     PR until they do,
//   - with a job that keeps its first task to reading.

import os from 'node:os';
import type { BotProfile } from '../../shared/bot';
import { hasBotsPlanConsent, type FactorySettings } from '../../shared/factorySettings';
import { dmThreadId } from '../../shared/room';
import {
  FIRST_RUN_BOT_WORKERS,
  type FirstBotResult,
  type FirstRunFolderCheck,
} from '../../shared/firstRun';
import type { BotStore } from '../factory/botStore';
import { brokenRepoRefusal, homeShortPath, liveWorkspaceRepo, recordWorkspaceRepo, resolveBotRepo, withWorkspaceRepoLock, workspaceBotsRepo, type BotRepoDeps } from '../factory/botCreate';
import { sameRepoKey } from '../../shared/forgeHosts';

/** The first-run bot's job: part of its system prompt. */
export const FIRST_RUN_BOT_JOB = [
  'You are the owner\'s first bot, made by the first run for this repository.',
  'Your first task only reads: explain, summarize or draft in the chat.',
  'Do not change files, start workers, push, or open a pull request unless the owner asks for that in this chat after your first answer.',
  'When something would need workers, say so and tell the owner they can allow workers in your settings.',
].join(' ');

export interface FirstBotDeps extends BotRepoDeps {
  homeDir?: string;
}

/** firstRun:check-folder: whether a bot can read `folder`. */
export async function checkFirstRunFolder(folder: unknown, deps: FirstBotDeps = {}): Promise<FirstRunFolderCheck> {
  const resolved = await resolveBotRepo(folder, deps);
  if (!resolved.ok) {
    if (resolved.code === 'not_a_repo' || resolved.code === 'no_remote') return { ok: false, code: resolved.code, message: resolved.message };
    return { ok: false, code: 'invalid_argument', message: resolved.message };
  }
  const root = resolved.repo.repoPath;
  return { ok: true, root, displayRoot: homeShortPath(root, deps.homeDir ?? os.homedir()), repoKey: resolved.repo.repoKey };
}

/** The live first-run bot, when there is one. */
export function findFirstRunBot(store: BotStore): BotProfile | null {
  return store.list().find((b) => b.firstRun === true) ?? null;
}

function answer(bot: BotProfile, created: boolean): FirstBotResult {
  return {
    ok: true,
    created,
    bot: { id: bot.id, name: bot.name, workspaceId: bot.workspaceId, repoPath: bot.repo?.repoPath ?? '' },
    threadId: dmThreadId(bot.id),
  };
}

/**
 * firstRun:first-bot's body. `settings` is the factory's live settings (null
 * before the runtime has started); the bot is made only when the plan consent
 * is stored and the bots are on.
 */
export async function firstRunBot(
  store: BotStore | null,
  settings: FactorySettings | null,
  req: unknown,
  deps: FirstBotDeps = {},
): Promise<FirstBotResult> {
  if (!hasBotsPlanConsent(settings) || settings?.enabled !== true) {
    return { ok: false, code: 'consent_required', message: 'The bots need the plan consent and to be on before the first task.' };
  }
  if (!store) return { ok: false, code: 'not_started', message: 'The bots are still starting.' };
  const existing = findFirstRunBot(store);
  if (existing) return answer(existing, false);
  const r = req && typeof req === 'object' && !Array.isArray(req) ? (req as Record<string, unknown>) : {};
  if (typeof r.workspaceId !== 'string' || r.workspaceId.length === 0) {
    return { ok: false, code: 'invalid_argument', message: 'workspaceId must be a workspace id' };
  }
  const workspaceId = r.workspaceId;
  return withWorkspaceRepoLock(workspaceId, async (): Promise<FirstBotResult> => {
    const resolved = await resolveBotRepo(r.folder, deps);
    if (!resolved.ok) {
      if (resolved.code === 'not_a_repo' || resolved.code === 'no_remote') return { ok: false, code: resolved.code, message: resolved.message };
      return { ok: false, code: 'invalid_argument', message: resolved.message };
    }
    // Read after the await: a first-run bot made meanwhile is the one.
    const made = findFirstRunBot(store);
    if (made) return answer(made, false);
    // Only a bot of the workspace binds it; a remembered repository no bot
    // holds gives way to the folder picked here.
    const current = workspaceBotsRepo(store, workspaceId);
    if (current && !sameRepoKey(current.repoKey, resolved.repo.repoKey)) {
      return {
        ok: false,
        code: 'repo_mismatch',
        message: `This workspace's bots work on ${current.repoKey} (${current.repoPath}); ${resolved.repo.repoPath} is ${resolved.repo.repoKey}. A workspace works on one repository.`,
      };
    }
    // The bots' repository is resolved again before a new bot takes it.
    const live = current ? await liveWorkspaceRepo(store, workspaceId, deps) : null;
    if (live && 'broken' in live) {
      const refused = brokenRepoRefusal(live.broken);
      return { ok: false, code: refused.code === 'repo_untrusted' ? 'not_a_repo' : refused.code, message: refused.message };
    }
    const created = store.create({
      workspaceId,
      template: 'custom',
      repo: current ?? resolved.repo,
      job: FIRST_RUN_BOT_JOB,
      budget: { maxConcurrentWorkers: FIRST_RUN_BOT_WORKERS },
      firstRun: true,
    });
    if (!created.ok) {
      return { ok: false, code: created.code === 'too_many_bots' ? 'too_many_bots' : 'invalid_argument', message: created.message };
    }
    // The workspace's repository from now on: Add bot there does not ask again.
    if (created.bot.repo) recordWorkspaceRepo(store, created.bot.workspaceId, created.bot.repo, deps, { fill: current === null });
    return answer(created.bot, true);
  });
}
