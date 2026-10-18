import { agentDisplayToSlug } from '../shared/agentIdentity';
import { screenShowsActiveDialog, screenShowsRunningTurn } from './transcript/chatScreenGate';
import { claudeComposerVisible, codexComposerVisible } from './transcript/deliverChatPrompt';

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

/**
 * The agent a recovered pane's screen tier has sighted since recovery, when
 * its live chrome can be read off the screen (Claude Code, Codex). The
 * pane's detector is new with the respawned shell and is fed only live
 * output, so a name here was drawn after the restart, never by the dead
 * session.
 *
 * A sighting only hides the recovery pill. It never consumes the offer: that
 * takes a hook or a live process (see the `session:agent` handler).
 */
export function sightedRecoveredAgent(screenAgent: string | null | undefined): 'claude' | 'codex' | undefined {
  const slug = agentDisplayToSlug(screenAgent ?? '');
  return slug === 'claude' || slug === 'codex' ? slug : undefined;
}

/**
 * Is the sighted agent still on the visible screen? Its composer, its running
 * turn row, or a dialog it owns. Once the agent exits, its composer is gone
 * from the grid (captured on Claude Code's classic and fullscreen renderers),
 * so the sighting goes stale and the pill shows again.
 */
export function screenShowsLiveAgent(rows: readonly string[], slug: 'claude' | 'codex'): boolean {
  const composer = slug === 'claude' ? claudeComposerVisible(rows) : codexComposerVisible(rows);
  return composer || screenShowsRunningTurn(rows, slug) || screenShowsActiveDialog(rows);
}
