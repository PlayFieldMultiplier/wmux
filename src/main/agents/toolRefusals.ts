// The last refused tool call of each pane's agent, as the daemon reads it from
// the agent's transcript (daemon/transcript/toolRefusals, `agent.refusal`).
// Data only: pane.list reports it, and a fenced bot worker's needs-input fact
// says its turn stopped on one. Desktop-only: no phone payload carries it.

import type { ToolRefusal } from '../../shared/toolRefusal';

const byPty = new Map<string, ToolRefusal>();

export function setToolRefusal(ptyId: string, refusal: ToolRefusal | null): void {
  if (refusal) byPty.set(ptyId, refusal);
  else byPty.delete(ptyId);
}

export function toolRefusalOf(ptyId: string): ToolRefusal | null {
  return byPty.get(ptyId) ?? null;
}

/** The newest refusal among a pane's surfaces, or null. */
export function lastToolRefusal(ptyIds: readonly string[]): ToolRefusal | null {
  let last: ToolRefusal | null = null;
  for (const id of ptyIds) {
    const r = byPty.get(id);
    if (r && (!last || r.at > last.at)) last = r;
  }
  return last;
}

/** The daemon went away: what it said is no longer known. */
export function clearToolRefusals(): void {
  byPty.clear();
}
