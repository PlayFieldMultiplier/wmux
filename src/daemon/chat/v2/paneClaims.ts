/**
 * Panes that hold a chat-v2 record. The chat-v2 host is the only writer; the
 * older managed-chat service reads it so its `respond` can never answer a
 * request on a pane whose decisions belong to a chat-v2 driver (those go
 * through the ApprovalRegistry and nothing else).
 */
const claimed = new Set<string>();

export function claimChatV2Pane(paneId: string): void {
  claimed.add(paneId);
}

export function releaseChatV2Pane(paneId: string): void {
  claimed.delete(paneId);
}

export function chatV2OwnsPane(paneId: string): boolean {
  return claimed.has(paneId);
}

/**
 * Panes with a move between the terminal and a chat (or between accounts)
 * under way: chat → terminal, terminal → chat and Continue on another
 * account each stop the pane's agent and start another, so a second one is
 * refused, never interleaved.
 */
const moving = new Set<string>();

/** False when another move holds the pane. Pair a true answer with `endPaneMove`. */
export function beginPaneMove(paneId: string): boolean {
  if (moving.has(paneId)) return false;
  moving.add(paneId);
  return true;
}

export function endPaneMove(paneId: string): void {
  moving.delete(paneId);
}

/** A move holds the pane: nothing else may start an agent or a chat in it. */
export function isPaneMoving(paneId: string): boolean {
  return moving.has(paneId);
}
