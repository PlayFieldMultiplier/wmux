// The last refused tool call of each pane's agent, as the daemon reads it from
// the agent's transcript (daemon/transcript/toolRefusals, `agent.refusal`),
// held by the connected DaemonClient. Data only: pane.list reports it, and a
// fenced bot worker's turn end that stopped on one becomes a pane.idle fact.
// Desktop-only: no phone payload carries it.

import type { ToolRefusal } from '../../shared/toolRefusal';

let source: ((ptyId: string) => ToolRefusal | null) | null = null;

/** The connected daemon client's refusals (main/index.ts sets it on each install). */
export function setToolRefusalSource(fn: ((ptyId: string) => ToolRefusal | null) | null): void {
  source = fn;
}

export function toolRefusalOf(ptyId: string): ToolRefusal | null {
  return source?.(ptyId) ?? null;
}

/** The newest refusal among a pane's surfaces, or null. */
export function lastToolRefusal(ptyIds: readonly string[]): ToolRefusal | null {
  let last: ToolRefusal | null = null;
  for (const id of ptyIds) {
    const r = toolRefusalOf(id);
    if (r && (!last || r.at > last.at)) last = r;
  }
  return last;
}
