// ─── Bot workers live on the Bots page (2026-10-13, 2026-10-14) ────────────
//
// A fan-out task a factory bot dispatched is the bot's worker, not the
// owner's own work: it is shown on the Bots page, under the bot that started
// it, and nowhere else. The Workspaces sidebar, its collapsed rail form, the
// Ctrl+N digits, the Tasks line and Fleet (its board, its counts, the rail
// and status-bar badges) leave it out, and the "Workspaces N" header never
// counts it — the workspace the owner is in included (owner decision
// 2026-10-14: a bot's worker opens inside the Bots page).
//
// Which bot owns a task workspace: its lineage origin (`{kind:'bot', botId}`,
// `fanoutOrigin`). After a restart main answers it from the task ledger's
// dispatch record when the lineage stamp lacks it (FANOUT_LINEAGE), so the
// worker stays told apart.

import type { FanoutOrigin } from '../../../shared/fanoutOrigin';

interface Identified {
  id: string;
}

/** Task workspace id → the bot that owns it. */
export type BotTaskOwners = Readonly<Record<string, string>>;

type Origins = Readonly<Record<string, FanoutOrigin | undefined>> | undefined;

const NO_OWNERS: BotTaskOwners = Object.freeze({});

/** The bot that owns a task workspace of this origin, or undefined. A bot
 *  origin naming no bot is still a bot's task (owner unknown: ''). */
function botOwnerOf(origin: FanoutOrigin | undefined): string | undefined {
  return origin?.kind === 'bot' ? origin.botId ?? '' : undefined;
}

function sameOwners(a: BotTaskOwners, b: BotTaskOwners): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

let ownersMemo: { workspaces: readonly Identified[]; origins: Origins; out: BotTaskOwners } | null = null;

/** Every bot task among `workspaces` (open ones only), by workspace id. The
 *  same object while the answer is unchanged, so a subscriber does not
 *  re-render. */
export function botTaskOwners(workspaces: readonly Identified[], origins: Origins): BotTaskOwners {
  const memo = ownersMemo;
  if (memo && memo.workspaces === workspaces && memo.origins === origins) return memo.out;
  const next: Record<string, string> = {};
  let any = false;
  for (const w of workspaces) {
    const owner = botOwnerOf(origins?.[w.id]);
    if (owner === undefined) continue;
    next[w.id] = owner;
    any = true;
  }
  const computed = any ? next : NO_OWNERS;
  const out = memo && sameOwners(memo.out, computed) ? memo.out : computed;
  ownersMemo = { workspaces, origins, out };
  return out;
}

/** The store's bot tasks (see botTaskOwners). */
export function selectBotTaskOwners(state: { workspaces: readonly Identified[]; fanoutOrigin?: Origins }): BotTaskOwners {
  return botTaskOwners(state.workspaces, state.fanoutOrigin);
}

/** Whether workspace `id` is a bot's task. */
export function isBotTask(id: string | undefined, owners: BotTaskOwners): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(owners, id);
}

/** The list without bot workers. Returns the same array when nothing is
 *  left out. */
export function withoutBotTasks<T extends { id: string }>(list: readonly T[], owners: BotTaskOwners): T[] {
  if (owners === NO_OWNERS) return list as T[];
  const kept = list.filter((w) => !isBotTask(w.id, owners));
  return kept.length === list.length ? (list as T[]) : kept;
}

let ownerListMemo: { workspaces: readonly Identified[]; owners: BotTaskOwners; out: readonly Identified[] } | null = null;

/** The store's workspaces without bot workers (Fleet's board and counts).
 *  The store's own array while there is no bot worker, and the same filtered
 *  array while neither input changes, so selectors memoized on the
 *  workspaces' identity keep working. */
export function selectOwnerWorkspaces<W extends Identified>(state: { workspaces: readonly W[]; fanoutOrigin?: Origins }): W[] {
  const owners = selectBotTaskOwners(state);
  if (owners === NO_OWNERS) return state.workspaces as W[];
  const memo = ownerListMemo;
  if (memo && memo.workspaces === state.workspaces && memo.owners === owners) return memo.out as W[];
  const out = withoutBotTasks(state.workspaces, owners);
  ownerListMemo = { workspaces: state.workspaces, owners, out };
  return out;
}
