// ─── Bot recipes — data only, each a read-and-report job ───────────────────
//
// A recipe is a starting point for "Add bot": it prefills the job text and
// names the connections the job needs. The bot is made through the one
// create path (shared/botCreate.ts) and the recipe grants nothing: no
// connection is made, enabled, signed in or given to the bot, and no tool is
// picked. The owner does that in Plugins › Connectors, as for any
// connection. The bot keeps the recipe's id (BotProfile.recipe, display
// only), so its profile can list what each connection still needs.
//
// Every recipe only reads and reports, because a bot's worker gets a
// signed-in connection only through main's gateway (main/connectors/
// workerGateway.ts), and that path is read-only: the research preset, the
// owner's picked tools, each one marked read-only by the service, no other
// connection in the same task, no Windows. Anything a job would write (a
// reply, an event, a page) is drafted in the chat for the owner. GitHub is
// the one preset here (shared/botConnectorPresets.ts): a key, not a sign-in,
// with its write tools blocked. A recipe never mixes it with a sign-in
// service, since a task with a signed-in connection carries no other kind.
//
// A bot sets its own routines, and only on the owner's words
// (main/pipe/handlers/routine.rpc.ts turnOnOwnerWords), so a suggested
// schedule is never set here: the job asks the bot to offer it in its
// greeting and to set it once the owner picks it.

import type { BotTemplate } from './bot';
import type { Connector, ConnectorPresetId } from './botConnector';
import { connectorsForBot } from './botConnector';
import type { RoutineSchedule } from './botRoutine';
import { CONNECTOR_SERVICES } from './connectorServices';

/** A connection a recipe needs: a CONNECTOR_SERVICES id, or a preset id. */
export type BotRecipeConnector = string;

export interface BotRecipe {
  id: string;
  /** i18n key of the recipe's name. */
  titleKey: string;
  /** i18n key of its one-line description. */
  hintKey: string;
  /** i18n key of what the job asks for; the full job adds the shared
   *  how-to-work lines (renderer botRecipeView.ts recipeJob). */
  jobKey: string;
  /** The template the bot is made from. Never 'researcher': its tasks are
   *  always counted as started from outside text, which the gateway refuses. */
  template: BotTemplate;
  /** The connections it needs, in the order they are listed. */
  connectors: readonly BotRecipeConnector[];
  /** When the job suggests the bot run on its own (offered, never set here). */
  suggestedSchedule?: RoutineSchedule;
}

function recipe(id: string, connectors: readonly BotRecipeConnector[], suggestedSchedule?: RoutineSchedule): BotRecipe {
  return {
    id,
    titleKey: `botRecipes.${id}.title`,
    hintKey: `botRecipes.${id}.hint`,
    jobKey: `botRecipes.${id}.job`,
    // Custom: no template default moves the bot's model or grants a power.
    template: 'custom',
    connectors,
    ...(suggestedSchedule ? { suggestedSchedule } : {}),
  };
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const at = (hour: number, minute: number, weekdays: number[]): RoutineSchedule => ({ kind: 'daily', hour, minute, weekdays });

/** One-click sign-in services first, then the GitHub preset, then the
 *  services that need the owner's own OAuth client. */
export const BOT_RECIPES: readonly BotRecipe[] = [
  recipe('notionMeetingDigest', ['notion'], at(9, 0, [1])),
  recipe('notionStalePages', ['notion'], at(16, 0, [5])),
  recipe('figmaHandoff', ['figma']),
  recipe('canvaCopyCheck', ['canva']),
  recipe('linearStandup', ['linear'], at(9, 0, WEEKDAYS)),
  recipe('atlassianSprint', ['atlassian'], at(9, 0, [1])),
  recipe('asanaDueSoon', ['asana'], at(8, 30, WEEKDAYS)),
  recipe('githubWeek', ['github'], at(9, 0, [1])),
  recipe('gmailTriage', ['gmail'], at(8, 0, WEEKDAYS)),
  recipe('meetingPrep', ['google-calendar', 'gmail'], at(8, 0, WEEKDAYS)),
  recipe('freeSlots', ['google-calendar']),
  recipe('sheetReport', ['google-sheets'], at(9, 0, [1])),
  recipe('driveStaleFiles', ['google-drive']),
  recipe('slackCatchUp', ['slack'], at(9, 0, WEEKDAYS)),
  recipe('slackDecisions', ['slack'], at(16, 0, [5])),
];

/** The presets a recipe may name, with their display names. */
const PRESET_NAMES: Readonly<Partial<Record<ConnectorPresetId, string>>> = { github: 'GitHub' };

export function botRecipe(id: unknown): BotRecipe | undefined {
  return typeof id === 'string' ? BOT_RECIPES.find((r) => r.id === id) : undefined;
}

/** A connection's display name (the service's own, or the preset's), or
 *  undefined when the id is neither. */
export function recipeConnectorName(id: BotRecipeConnector): string | undefined {
  return CONNECTOR_SERVICES.find((s) => s.id === id)?.name ?? PRESET_NAMES[id as ConnectorPresetId];
}

/** Whether a catalog service is signed in with the owner's own OAuth client
 *  (Google, Slack) rather than in one click. */
export function recipeConnectorNeedsOwnClient(id: BotRecipeConnector): boolean {
  const service = CONNECTOR_SERVICES.find((s) => s.id === id);
  return !!service && service.setup !== 'oauth';
}

/** Whether any of a recipe's connections needs the owner's own OAuth client. */
export function recipeNeedsOwnClient(r: Pick<BotRecipe, 'connectors'>): boolean {
  return r.connectors.some(recipeConnectorNeedsOwnClient);
}

/** Whether a library connection is the one a recipe names: a service by its
 *  endpoint (as the service catalog finds an existing one), a preset by its
 *  preset id. */
export function connectorServes(id: BotRecipeConnector, c: Pick<Connector, 'transport' | 'remote' | 'preset'>): boolean {
  const service = CONNECTOR_SERVICES.find((s) => s.id === id);
  if (service) return c.transport === 'http' && c.remote?.url === service.url;
  return id in PRESET_NAMES && c.preset === id;
}

/** Where one of a recipe's connections stands for one bot, as its next step:
 *  platform    Windows: no connection reaches a bot's worker there yet.
 *  signIn      the library has none, or it is not signed in (a service) or
 *              its key is not stored (the GitHub preset).
 *  checking    its sign-in is being read.
 *  notForBot   it is off, or not given to this bot.
 *  toolsNotPicked  a service with no tools picked (a worker gets only the
 *              tools the owner picked), or a preset listing none.
 *  connected   it applies to this bot, ready for a worker. */
export type RecipeConnectorState = 'platform' | 'signIn' | 'checking' | 'notForBot' | 'toolsNotPicked' | 'connected';

/** How far along each state is: the best of a service's connections wins. */
const PROGRESS: Readonly<Record<RecipeConnectorState, number>> = {
  platform: -1, signIn: 0, checking: 1, notForBot: 2, toolsNotPicked: 3, connected: 4,
};

export interface RecipeConnectorContext {
  library: readonly (Connector & { missingKeys?: readonly string[] })[];
  botId: string;
  platform: string | undefined;
  /** A service connection's sign-in: true signed in, false not, undefined
   *  not read yet. */
  signedIn: (connectorId: string) => boolean | undefined;
}

/** One connection's state for a bot. Pure. */
export function recipeConnectorState(id: BotRecipeConnector, ctx: RecipeConnectorContext): RecipeConnectorState {
  if (ctx.platform === 'win32') return 'platform';
  const isService = CONNECTOR_SERVICES.some((s) => s.id === id);
  let best: RecipeConnectorState = 'signIn';
  for (const c of ctx.library) {
    if (!connectorServes(id, c)) continue;
    const signed = isService ? ctx.signedIn(c.id) : (c.missingKeys ?? []).length === 0;
    let state: RecipeConnectorState;
    if (signed === false) state = 'signIn';
    else if (signed === undefined) state = 'checking';
    else if (connectorsForBot([c], ctx.botId).length === 0) state = 'notForBot';
    else if (c.tools.mode === 'listed' ? c.tools.allowed.length === 0 : isService) state = 'toolsNotPicked';
    else state = 'connected';
    if (PROGRESS[state] > PROGRESS[best]) best = state;
  }
  return best;
}

/** Each connection a recipe needs, its name and its state for one bot. Pure. */
export function recipeChecklist(
  r: Pick<BotRecipe, 'connectors'>,
  ctx: RecipeConnectorContext,
): { id: BotRecipeConnector; name: string; state: RecipeConnectorState }[] {
  return r.connectors.map((id) => ({ id, name: recipeConnectorName(id) ?? id, state: recipeConnectorState(id, ctx) }));
}
