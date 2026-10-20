import type { BrowserWindow } from 'electron';

type RevealableWindow = Pick<BrowserWindow, 'once' | 'show' | 'maximize' | 'isDestroyed' | 'isVisible'> & {
  webContents: Pick<BrowserWindow['webContents'], 'on' | 'once'>;
};

/**
 * Show a window built hidden once it has painted (#2512). Windows draws a
 * window that is shown before Chromium's first frame in the system's blank
 * colour, so the opaque window is built with `show: false` and revealed on
 * `ready-to-show`, which fires on the first paint, before the bundle runs: the
 * window appears in its start colour rather than later.
 *
 * A page that fails to load, or a renderer that dies before it paints, still
 * reveals the window: a live app with no window could only be killed. A
 * restored maximized window is maximized here, since maximize() shows a hidden
 * window and would reveal it before its first frame.
 */
export function revealWhenPainted(win: RevealableWindow, opts: { maximize: boolean }): void {
  let revealed = false;
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (opts.maximize) win.maximize();
    else if (!win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  // A subframe's failure says nothing about the page.
  win.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) reveal();
  });
  win.webContents.once('render-process-gone', reveal);
}
