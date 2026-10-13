// ─── What a bot can do (pure) ─────────────────────────────────────────────
//
// Every bot holds the same powers, the shared surface (shared/botSurface.ts
// SHARED_SURFACE); a Coordinator-template bot may also read other
// workspaces' rooms and facts. The profile shows them, it never edits them.
// Each owner phrase stands for the surface tools behind it and is shown only
// when the surface holds one of them, so the list can never claim a power
// the surface lacks. Tools that only read the factory's own event feeds have
// no phrase.

import { isCoordinatorBot, type BotRole, type BotTemplate } from '../../../shared/bot';
import { SHARED_SURFACE, type BotToolName } from '../../../shared/botSurface';

/** Owner phrases in display order: the i18n key and the tools it stands for. */
export const CAN_DO_PHRASES: ReadonlyArray<{ key: string; tools: readonly BotToolName[] }> = [
  { key: 'botsPage.canDo.talk', tools: ['room_post', 'room_read', 'handoff_send', 'bot_list'] },
  { key: 'botsPage.canDo.ask', tools: ['ask_person', 'question_close'] },
  { key: 'botsPage.canDo.fanout', tools: ['fanout_start', 'worker_resume', 'worker_message'] },
  { key: 'botsPage.canDo.workspaces', tools: ['workspace_list'] },
  { key: 'botsPage.canDo.terminals', tools: ['terminal_read'] },
  { key: 'botsPage.canDo.tasks', tools: ['ledger_update'] },
  { key: 'botsPage.canDo.read', tools: ['pr_read', 'issue_read', 'ci_read', 'verdict_read', 'trust_metrics_read'] },
  { key: 'botsPage.canDo.verdict', tools: ['pr_verdict'] },
  { key: 'botsPage.canDo.plan', tools: ['plan_propose'] },
  { key: 'botsPage.canDo.job', tools: ['job_set'] },
  { key: 'botsPage.canDo.routines', tools: ['routine_set', 'routine_list', 'routine_pause'] },
  { key: 'botsPage.canDo.stop', tools: ['stop_my_work'] },
  { key: 'botsPage.canDo.approval', tools: ['approval_request', 'approval_list'] },
  { key: 'botsPage.canDo.secrets', tools: ['secret_request', 'secret_list', 'login_request'] },
];

/** The Coordinator template's one extra power (reads in every workspace). */
export const CAN_DO_COORDINATOR = 'botsPage.canDo.coordinator';

/** Surface tools with no owner phrase: event feeds the bot reads to follow
 *  the factory, not powers the owner grants. */
export const CAN_DO_UNLISTED: ReadonlySet<BotToolName> = new Set<BotToolName>(['fact_poll']);

/** The i18n keys of what a bot can do, in display order. Pure. */
export function botCanDo(bot: { role: BotRole; template?: BotTemplate }): string[] {
  const keys = CAN_DO_PHRASES.filter((p) => p.tools.some((tool) => SHARED_SURFACE.tools.has(tool))).map((p) => p.key);
  return isCoordinatorBot(bot) ? [...keys, CAN_DO_COORDINATOR] : keys;
}
