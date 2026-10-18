import { agentDisplayToSlug } from '../shared/agentIdentity';
import { screenShowsActiveDialog } from './transcript/chatScreenGate';

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

/** A rule Claude draws above and below its prompt row (labeled or not). */
const CLAUDE_RULE_ROW = /^─{8,}/;
/** Codex's footer under its composer: the model/cwd row or the shortcut hint. */
const CODEX_FOOTER_ROW = /^\s+(?:\S.+ · (?:[A-Za-z]:[\\/]|\/|~)|(?:← for agents · )?\? for shortcuts?\b)/;

/**
 * Is the sighted agent still on the visible screen? Its composer, empty or
 * holding a draft, at the bottom of the grid, or a dialog it owns there.
 *
 * Claude and Codex draw every row under their prompt row indented (a draft's
 * continuation, the footer, the status line; captured on Claude Code 2.1 and
 * Codex 0.157), so a row at column 0 below it is the shell's: its prompt, or
 * `Killed` after the agent was stopped from outside. Once the agent exits its
 * composer is erased (captured on Claude Code's classic and fullscreen
 * renderers) or left above that shell row, and the sighting is stale. The
 * grid is read in an alternate screen too: an agent killed without leaving it
 * must not read as live for good. Not the chat-send gates' composer checks:
 * those refuse a whole screen that mentions `Esc to cancel` anywhere, which
 * here would show the pill over a live agent.
 */
export function screenShowsLiveAgent(rows: readonly string[], slug: 'claude' | 'codex'): boolean {
  if (screenShowsActiveDialog(rows)) return true;
  const isPrompt = slug === 'claude'
    ? (row: string) => /^❯(?:\s|$)/.test(row)
    : (row: string) => /^\s*›(?:\s|$)/.test(row);
  let at = rows.length - 1;
  while (at >= 0 && !isPrompt(rows[at])) at--;
  if (at < 0) return false;
  const below = rows.slice(at + 1).filter((row) => row.trim().length > 0);
  if (slug === 'claude') {
    // The prompt row between two rules, and only indented rows under them.
    const close = below.findIndex((row) => CLAUDE_RULE_ROW.test(row));
    return at > 0 && CLAUDE_RULE_ROW.test(rows[at - 1].trim()) && close >= 0
      && below.every((row, i) => i === close || /^\s/.test(row));
  }
  return below.some((row) => CODEX_FOOTER_ROW.test(row)) && below.every((row) => /^\s/.test(row));
}
