import { START_POLARITY_STORAGE_KEY, WINDOW_START_THEME, type StartPolarity } from '../../shared/windowStartPaint';

type ThemedRoot = Pick<HTMLElement, 'getAttribute' | 'setAttribute'>;

/**
 * The theme on screen before the session loads (#2512): the default theme of
 * the polarity main started the window in, else the store's default. The
 * store keeps its default until loadSession restores the saved theme.
 */
export function startTheme(polarity: StartPolarity | null | undefined, storeTheme: string): string {
  return polarity ? WINDOW_START_THEME[polarity] : storeTheme;
}

/**
 * Once the session's settings are in, put the store's theme back on screen if
 * the session restored none (a session with no workspaces returns before its
 * theme), so the screen and the store never disagree. A restored theme has
 * already replaced the start theme and is left alone.
 */
export function settleStartTheme(root: ThemedRoot, shown: string, storeTheme: string): void {
  if (root.getAttribute('data-theme') === shown && shown !== storeTheme) root.setAttribute('data-theme', storeTheme);
}

/** Record the polarity on screen for the next reload's start (the preload reads it). */
export function rememberStartPolarity(storage: () => Pick<Storage, 'setItem'> | undefined, polarity: StartPolarity): void {
  try {
    storage()?.setItem(START_POLARITY_STORAGE_KEY, polarity);
  } catch {
    // Storage can be unavailable; a reload then starts from the window's polarity.
  }
}
