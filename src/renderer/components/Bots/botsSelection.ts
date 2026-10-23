// The conversation the Bots page shows, kept while the app runs: leaving the
// page and coming back opens it again. Another surface may name it before
// opening the page (the first-run wizard's "Open the conversation"); it lives
// here, apart from the page, so that surface does not load the page itself.
import { botConversationId } from './botsModel';

let lastSelected: string | null = null;

export function lastBotsConversation(): string | null {
  return lastSelected;
}

export function rememberBotsConversation(conversationId: string): void {
  lastSelected = conversationId;
}

/** Open a bot's 1:1 the next time the Bots page opens. */
export function selectBotConversationOnOpen(botId: string): void {
  lastSelected = botConversationId(botId);
}
