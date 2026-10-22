// #2372 — `daemon.getAgentState` with `ids` reads several panes in one call,
// so a burst of per-pane reads (main's resync, the renderer's name reads at
// startup) costs one RPC instead of one per pane.

/** Most panes one batched read may name. */
export const AGENT_STATE_BATCH_MAX = 256;

/**
 * The batched reply: one entry per distinct id, each shaped exactly like a
 * single-id reply. Throws on anything but an array of 1..AGENT_STATE_BATCH_MAX
 * strings.
 */
export function agentStatesFor<T>(ids: unknown, read: (id: string) => T): { states: Record<string, T> } {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > AGENT_STATE_BATCH_MAX || !ids.every((id) => typeof id === 'string')) {
    throw new Error(`daemon.getAgentState: ids must be 1..${AGENT_STATE_BATCH_MAX} strings`);
  }
  const states: Record<string, T> = Object.create(null);
  for (const id of ids as string[]) if (!(id in states)) states[id] = read(id);
  return { states };
}
