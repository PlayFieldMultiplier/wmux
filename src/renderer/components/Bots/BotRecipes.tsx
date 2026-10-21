// ─── Bot recipes: the Add bot picker and the profile's checklist ───────────
//
// A recipe (shared/botRecipes.ts) prefills a new bot's job and names the
// connections that job needs; it grants nothing. Add bot shows a Recipe
// select over the template chips, with one muted line on what the recipe
// reads and what it needs. The bot keeps the recipe's id, and its profile
// lists each of those connections with where it stands — connected, sign in
// needed, not given to this bot, tools not picked, or macOS and Linux only —
// each a link to Plugins › Connectors, where the owner sets it up.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import Select from '../ui/Select';
import { botTemplate, type BotProfile } from '../../../shared/bot';
import type { ConnectorView } from '../../../shared/botConnector';
import type { ConnectorOAuthStatus } from '../../../shared/connectorOAuth';
import {
  BOT_RECIPES,
  botRecipe,
  connectorServes,
  recipeChecklist,
  recipeConnectorName,
  recipeConnectorNeedsOwnClient,
  recipeNeedsOwnClient,
  type BotRecipe,
  type RecipeConnectorState,
} from '../../../shared/botRecipes';
import { CONNECTOR_SERVICES } from '../../../shared/connectorServices';
import { routineScheduleText } from '../Schedules/BotRoutines';
import { getBotConnectorPort, useBotConnectors, type BotConnectorPort } from '../Room/botConnectors';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The connection names a recipe lists, joined for one line. */
function connectionNames(r: Pick<BotRecipe, 'connectors'>): string {
  return r.connectors.map((id) => recipeConnectorName(id) ?? id).join(', ');
}

/** The job a recipe prefills, in the owner's language: what it asks for,
 *  then how to work (the research preset, its connections only, reads only,
 *  writes drafted in the chat), what to say when a worker is refused, and,
 *  with a suggested schedule, the offer to make in the greeting. Pure. */
export function recipeJob(r: BotRecipe, t: T): string {
  const parts = [
    t(r.jobKey),
    t('botRecipes.common.work', { connections: connectionNames(r) }),
    t('botRecipes.common.refused'),
  ];
  if (r.suggestedSchedule) parts.push(t('botRecipes.common.schedule', { schedule: routineScheduleText(r.suggestedSchedule) }));
  return parts.join('\n\n');
}

/** The recipe groups of the picker, in catalog order: one-click sign-in,
 *  a key (the GitHub preset), the owner's own OAuth client. */
function recipeGroup(r: BotRecipe): 'oneClick' | 'key' | 'ownClient' {
  if (recipeNeedsOwnClient(r)) return 'ownClient';
  return r.connectors.every((id) => CONNECTOR_SERVICES.some((s) => s.id === id)) ? 'oneClick' : 'key';
}

/** Add bot's Recipe row: a native select (None, then the recipes by how
 *  they sign in) and, once one is picked, one muted line on what it reads,
 *  what it needs and that nothing is connected for it here. */
export function RecipePicker({ value, onChange, t, platform }: {
  value: string | null;
  onChange: (recipe: BotRecipe | null) => void;
  t: T;
  platform?: string;
}): React.ReactElement {
  const picked = botRecipe(value);
  const groups = (['oneClick', 'key', 'ownClient'] as const).map((g) => ({ g, items: BOT_RECIPES.filter((r) => recipeGroup(r) === g) }));
  return (
    <>
      <label className="flex items-center gap-2 text-[12px] text-[var(--text-sub)]">
        <span className="w-[120px] shrink-0">{t('settings.factory.addBotRecipe')}</span>
        <Select
          data-testid="factory-add-bot-recipe"
          value={picked?.id ?? ''}
          onChange={(e) => onChange(botRecipe(e.target.value) ?? null)}
        >
          <option value="">{t('settings.factory.addBotRecipeNone')}</option>
          {groups.map(({ g, items }) => (
            <optgroup key={g} label={t(`settings.factory.addBotRecipeGroup.${g}`)}>
              {items.map((r) => <option key={r.id} value={r.id}>{t(r.titleKey)}</option>)}
            </optgroup>
          ))}
        </Select>
      </label>
      {picked && (
        <div data-testid="factory-add-bot-recipe-note" className="pl-[128px] text-[11px] text-[var(--text-muted)]">
          {t(picked.hintKey)}
          {' '}
          {t('settings.factory.addBotRecipeReads', { connections: connectionNames(picked) })}
          {recipeNeedsOwnClient(picked) && ` ${t('settings.factory.addBotRecipeOwnClient')}`}
          {platform === 'win32' && ` ${t('settings.factory.addBotRecipePlatform')}`}
          {' '}
          {t('settings.factory.addBotRecipeSetup')}
        </div>
      )}
    </>
  );
}

/** A sign-in status as the checklist reads it: signed in, not, or not
 *  known yet (busy). Pure. */
export function signedInOf(status: ConnectorOAuthStatus | undefined): boolean | undefined {
  if (status === undefined || status === 'busy') return undefined;
  return status === 'authorized';
}

type OAuthAction = (action: 'status', id: string) => Promise<{ status: ConnectorOAuthStatus }>;

function oauthBridge(): OAuthAction | undefined {
  const api = (globalThis as { electronAPI?: { connectorOAuth?: { action?: OAuthAction } } }).electronAPI;
  return api?.connectorOAuth?.action;
}

/** The sign-in status of each library connection a recipe names (catalog
 *  services only), read again whenever one of them changes. */
function useSignIns(r: BotRecipe, library: readonly ConnectorView[], status: OAuthAction | undefined): Record<string, ConnectorOAuthStatus> {
  const services = useMemo(
    () => library.filter((c) => r.connectors.some((id) => CONNECTOR_SERVICES.some((s) => s.id === id) && connectorServes(id, c))),
    [library, r],
  );
  const key = services.map((c) => `${c.id}:${c.updatedAt}`).join(',');
  const [statuses, setStatuses] = useState<Record<string, ConnectorOAuthStatus>>({});
  useEffect(() => {
    if (!status || services.length === 0) return undefined;
    let live = true;
    for (const c of services) {
      status('status', c.id).then(
        (res) => { if (live) setStatuses((cur) => ({ ...cur, [c.id]: res.status })); },
        () => { if (live) setStatuses((cur) => ({ ...cur, [c.id]: 'unavailable' })); },
      );
    }
    return () => { live = false; };
    // `key` names the connections and their versions; `services` follows it.
  }, [key, status]);
  return statuses;
}

function openConnectors(): void {
  useStore.getState().setAppRoute('connectors');
}

/** The state word of one checklist row. A preset's sign-in is its key. */
function stateLabel(id: string, state: RecipeConnectorState, t: T): string {
  if (state === 'signIn' && !CONNECTOR_SERVICES.some((s) => s.id === id)) return t('botsPage.profile.recipeState.keyNeeded');
  return t(`botsPage.profile.recipeState.${state}`);
}

/** The profile's Recipe row: the recipe's name, then one line per
 *  connection it needs with its state for this bot, each a link to Plugins ›
 *  Connectors. Nothing for a bot made without a recipe, or one whose
 *  template has changed since (the recipe no longer describes it). */
export function BotRecipeChecklist(props: {
  bot: Pick<BotProfile, 'id' | 'recipe' | 'template' | 'role'>;
  t: T;
  port?: BotConnectorPort;
  oauthStatus?: OAuthAction;
  platform?: string;
}): React.ReactElement | null {
  const r = botRecipe(props.bot.recipe);
  if (!r || botTemplate(props.bot) !== r.template) return null;
  return <RecipeChecklist {...props} recipe={r} />;
}

function RecipeChecklist({ bot, recipe: r, t, port = getBotConnectorPort(), oauthStatus = oauthBridge(), platform }: {
  bot: Pick<BotProfile, 'id'>;
  recipe: BotRecipe;
  t: T;
  port?: BotConnectorPort;
  oauthStatus?: OAuthAction;
  platform?: string;
}): React.ReactElement {
  const { connectors } = useBotConnectors(port);
  const statuses = useSignIns(r, connectors, oauthStatus);
  const os = platform ?? (globalThis as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  const rows = recipeChecklist(r, { library: connectors, botId: bot.id, platform: os, signedIn: (id) => signedInOf(statuses[id]) });
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-recipe={r.id}>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.recipe')}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[var(--text-main)]">{t(r.titleKey)}</p>
        <ul className="space-y-0.5">
          {rows.map((row) => {
            const label = stateLabel(row.id, row.state, t);
            const ownClient = row.state === 'signIn' && recipeConnectorNeedsOwnClient(row.id);
            return (
              <li key={row.id} data-recipe-connector={row.id} data-state={row.state} className="flex items-baseline gap-2">
                <span className={`min-w-0 truncate ${row.state === 'connected' ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}>{row.name}</span>
                <button
                  type="button"
                  data-testid={`bot-recipe-state-${row.id}`}
                  title={t('botsPage.profile.recipeOpen')}
                  onClick={openConnectors}
                  className={`shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
                >
                  {ownClient ? `${label} · ${t('botsPage.profile.recipeOwnClient')}` : label}
                </button>
              </li>
            );
          })}
        </ul>
        {rows.some((row) => row.state !== 'connected') && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t('botsPage.profile.recipeHint')}</p>}
      </div>
    </div>
  );
}
