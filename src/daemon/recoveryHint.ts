/**
 * The recovery hint for a pane, or undefined once process truth shows the
 * pane's agent alive again.
 *
 * A banner clears the hint, but an agent that prints none after it was resumed
 * would otherwise keep it for as long as the daemon lives. A daemon that
 * outlives app quits then hands every new app session a resume hint for a pane
 * whose agent is running, and the renderer offers (or auto-types) the resume
 * into that agent's own input box. A stale hint is dropped together with its
 * recovery binding, the same pair the banner path clears.
 */
export function liveRecoveryHint<S, B>(
  id: string,
  agentAlive: (id: string) => boolean | undefined,
  hints: Map<string, S>,
  bindings: Map<string, B>,
): S | undefined {
  const slug = hints.get(id);
  if (slug !== undefined && agentAlive(id) === true) {
    hints.delete(id);
    bindings.delete(id);
    return undefined;
  }
  return slug;
}

/**
 * The liveness `liveRecoveryHint` may consume a hint on: a live process the
 * tracker attributed to a named agent. A slugless pick (an unknown wrapper,
 * or any direct child the probe found) is not evidence of an agent: a
 * `tail -f` printing a quoted banner arms the tracker and is picked as alive,
 * and consuming on it would drop the offer and its binding for good.
 */
export function namedAgentAlive(identity: { slug?: string; alive: boolean } | undefined): boolean | undefined {
  if (identity?.slug === undefined) return undefined;
  return identity.alive;
}
