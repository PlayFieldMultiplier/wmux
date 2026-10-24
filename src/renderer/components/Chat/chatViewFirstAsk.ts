import type { ChatViewAskAgent, ChatViewFirstAsk } from '../../../shared/types';

const ASKED_AGENTS: readonly ChatViewAskAgent[] = ['claude', 'codex'];

/**
 * The agent the one-time "Show this as a chat?" question is for, when a pane's
 * agent is `slug`: a supported agent whose answer is not recorded yet, and
 * never when the question is off (`'never'`).
 */
export function chatViewAskFor(ask: ChatViewFirstAsk, slug: string | undefined): ChatViewAskAgent | null {
  if (ask === 'never' || !slug) return null;
  const agent = ASKED_AGENTS.find((a) => a === slug);
  return agent && ask[agent] === undefined ? agent : null;
}

/**
 * The question's state from a saved session. A session that already holds a
 * chat-view setting, on or off, is an existing user's: they are never asked,
 * and their setting is left as it is. A session with neither (a first run, or
 * one saved before the setting existed) starts with nothing asked.
 */
export function chatViewFirstAskFromSession(data: { chatViewEnabled?: unknown; chatViewFirstAsk?: unknown }): ChatViewFirstAsk {
  const saved = data.chatViewFirstAsk;
  if (saved === 'never') return 'never';
  if (saved && typeof saved === 'object') {
    const out: Partial<Record<ChatViewAskAgent, 'show' | 'terminal'>> = {};
    for (const agent of ASKED_AGENTS) {
      const answer = (saved as Record<string, unknown>)[agent];
      if (answer === 'show' || answer === 'terminal') out[agent] = answer;
    }
    return out;
  }
  return typeof data.chatViewEnabled === 'boolean' ? 'never' : {};
}
