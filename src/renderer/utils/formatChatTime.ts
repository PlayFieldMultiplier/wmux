/** Chat timestamp — LOCAL wall-clock HH:MM (chat convention). The thread
 *  timestamps previously rendered `toISOString().slice(11,19)` = UTC, which
 *  reads 9h off on a KST machine — always go through this instead. */
export function formatChatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
