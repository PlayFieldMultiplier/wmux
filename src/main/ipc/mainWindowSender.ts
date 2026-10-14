// Which IPC senders speak for the operator: the main window's own top frame,
// and nothing else (not a subframe it hosts, not another window).

import type { BrowserWindow } from 'electron';

/** The request came from the main window's own top frame. */
export function isMainWindowSender(e: { sender?: unknown; senderFrame?: unknown }, win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return false;
  return !!e.senderFrame && e.senderFrame === win.webContents.mainFrame;
}
