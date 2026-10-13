// ─── Bot workers leave the Workspaces sidebar (2026-10-13) ──────────────────
//
// A fan-out task a factory bot dispatched (its lineage origin is
// `{kind:'bot', botId}`) is the bot's worker, not the owner's own work: it is
// shown on the Bots page, under the bot that started it, and Fleet keeps
// listing it with every other agent. The sidebar, its collapsed rail form and
// the Ctrl+N digits leave it out, and the "Workspaces N" header never counts
// it. The one exception is the workspace the owner is in right now (a jump to
// a worker's pane from Bots): it stays listed while it is active, so the
// row you are working in never vanishes, but it is still not counted and
// takes no Ctrl+N digit (a digit must not move when the owner leaves it).

import type { FanoutOrigin } from '../../../shared/fanoutOrigin';

/** Whether a task workspace's origin names a factory bot. */
export function isBotTask(origin: FanoutOrigin | undefined): boolean {
  return origin?.kind === 'bot';
}

/** The list without bot workers, keeping `keepId` (the active workspace)
 *  in place when it is one. Returns the same array when nothing is left out. */
export function withoutBotTasks<T extends { id: string }>(
  list: readonly T[],
  origins: Readonly<Record<string, FanoutOrigin | undefined>> | undefined,
  keepId?: string | null,
): T[] {
  if (!origins) return list as T[];
  const kept = list.filter((w) => w.id === keepId || !isBotTask(origins[w.id]));
  return kept.length === list.length ? (list as T[]) : kept;
}

/** How many of `list` the header counts: every row but a bot worker. */
export function countWithoutBotTasks(
  list: readonly { id: string }[],
  origins: Readonly<Record<string, FanoutOrigin | undefined>> | undefined,
): number {
  if (!origins) return list.length;
  let n = 0;
  for (const w of list) if (!isBotTask(origins[w.id])) n += 1;
  return n;
}
