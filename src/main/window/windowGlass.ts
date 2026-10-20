import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { parseWindowsBuildNumber } from '../../shared/platform';
import {
  WINDOW_GLASS_LEVELS,
  isWindowGlassSupported,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';
import { winOverlayHeight } from './uiZoom';

/**
 * Windows window glass (DESIGN.md "Window glass"). On Windows 11 22H2+ the
 * window gets the acrylic backdrop behind a transparent background, the same
 * role the vibrancy material plays on macOS; the renderer then tints only the
 * frame and the sidebar over it (`data-glass`, globals.css) and the panes stay
 * opaque. Older Windows builds and glass Off keep the opaque window.
 *
 * Three native settings move together, or the window shows a seam:
 *   - the background material (`acrylic` or `none`);
 *   - the window background colour (transparent, or the opaque frame colour);
 *   - the titleBarOverlay colour: a solid strip would sit as a band across
 *     the glass behind the caption buttons, so it is transparent while glass
 *     is on. The renderer keeps sending the solid frame colour it paints, and
 *     main swaps in the transparent one here, so neither overlay sender
 *     (theme sync, UI-zoom sync) can repaint the band.
 *
 * Soft and Clear differ only in how much the page paints over the material,
 * so for main both mean acrylic.
 */

/** The opaque window's background and overlay colour: the default (Tint) theme's frame. */
export const WIN_OPAQUE_BACKGROUND = '#121015';
/** The overlay's caption-button colour before the renderer sends the theme's. */
export const WIN_OVERLAY_SYMBOL = '#C2BDC9';
export const TRANSPARENT = '#00000000';

/** Whether this Windows machine can show glass, from `os.release()`. False off Windows. */
export function windowsGlassSupported(platform: string, release: string): boolean {
  return platform === 'win32' && isWindowGlassSupported(platform, parseWindowsBuildNumber(release));
}

/** Whether a new window starts with glass: supported and the persisted level is not Off. */
export function initialWindowsGlass(supported: boolean, persistedLevel: unknown): boolean {
  return supported && resolveWindowGlass(persistedLevel) !== 'off';
}

/**
 * The win32 window options. With glass off they are exactly the opaque
 * window wmux has always opened: a solid overlay strip and a solid background
 * in the default theme's frame colour, so the first paint never flashes.
 */
export function winWindowOptions(glass: boolean): Partial<BrowserWindowConstructorOptions> {
  // Height 40 = uiZoom's CHROME_H at zoom 1 (the scaled resync uses it).
  const titleBarOverlay = { color: glass ? TRANSPARENT : WIN_OPAQUE_BACKGROUND, symbolColor: WIN_OVERLAY_SYMBOL, height: 40 };
  if (!glass) return { titleBarStyle: 'hidden', titleBarOverlay, backgroundColor: WIN_OPAQUE_BACKGROUND };
  return { titleBarStyle: 'hidden', titleBarOverlay, backgroundColor: TRANSPARENT, backgroundMaterial: 'acrylic' };
}

// Glass state per window, so the overlay senders know which colour to use.
const glassOn = new WeakMap<BrowserWindow, boolean>();

/** Record the glass state a window was built with (createWindow). */
export function markWindowGlass(win: BrowserWindow, on: boolean): void {
  glassOn.set(win, on);
}

export function isWindowGlassOn(win: BrowserWindow): boolean {
  return glassOn.get(win) === true;
}

/** The overlay colour to apply: transparent while the window shows glass, else the renderer's solid one. */
export function overlayColorFor(win: BrowserWindow, solid: string): string {
  return isWindowGlassOn(win) ? TRANSPARENT : solid;
}

type GlassWindow = Pick<
  BrowserWindow,
  'setBackgroundMaterial' | 'setBackgroundColor' | 'setTitleBarOverlay' | 'webContents'
>;

/**
 * Switch a live window's glass for a new level: material, background colour
 * and overlay colour together. With glass off the background goes back to
 * the construction colour, the same one an opaque window is built with: it
 * is never repainted on a theme change, so a theme's colour would go stale.
 * The overlay takes `colors`, the renderer's solid pair (the frame colour it
 * paints with glass off), which the theme sync keeps current; without it the
 * construction pair. Returns false when the window already had this state
 * and nothing was called.
 */
export function applyWindowsGlass(
  win: BrowserWindow,
  level: WindowGlassLevel,
  colors?: { color: string; symbolColor: string },
): boolean {
  const on = level !== 'off';
  if (isWindowGlassOn(win) === on) return false;
  const w: GlassWindow = win;
  w.setBackgroundMaterial(on ? 'acrylic' : 'none');
  w.setBackgroundColor(on ? TRANSPARENT : WIN_OPAQUE_BACKGROUND);
  w.setTitleBarOverlay({
    color: on ? TRANSPARENT : (colors?.color ?? WIN_OPAQUE_BACKGROUND),
    symbolColor: colors?.symbolColor ?? WIN_OVERLAY_SYMBOL,
    height: winOverlayHeight(w.webContents.getZoomFactor()),
  });
  glassOn.set(win, on);
  return true;
}

/**
 * Whether main follows the renderer's appearance request: macOS always (the
 * vibrancy material), Windows only where it can show glass (the acrylic tint
 * follows the app's appearance). Elsewhere overriding the appearance would
 * change native menus and the in-app browser for nothing.
 */
export function appearanceFollowsTheme(platform: string, windowsGlass: boolean): boolean {
  return platform === 'darwin' || (platform === 'win32' && windowsGlass);
}

/**
 * The WINDOW_SET_APPEARANCE handler: set the app's appearance from the
 * renderer's request where it follows the theme. Trust boundary: only
 * 'dark', 'light' or 'system' reach `themeSource`. Returns whether it changed.
 */
export function applyAppearance(
  theme: { themeSource: 'system' | 'light' | 'dark' },
  appearance: unknown,
  platform: string,
  windowsGlass: boolean,
): boolean {
  if (!appearanceFollowsTheme(platform, windowsGlass)) return false;
  if (appearance !== 'dark' && appearance !== 'light' && appearance !== 'system') return false;
  if (theme.themeSource === appearance) return false;
  theme.themeSource = appearance;
  return true;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The WINDOW_SET_GLASS payload, validated: a known level, and the overlay
 * pair only when both are #RGB/#RRGGBB (a malformed colour must never reach
 * the native setters, which throw). Null for anything else.
 */
export function parseGlassRequest(
  opts: unknown,
): { level: WindowGlassLevel; colors?: { color: string; symbolColor: string } } | null {
  if (!opts || typeof opts !== 'object') return null;
  const { level, color, symbolColor } = opts as { level?: unknown; color?: unknown; symbolColor?: unknown };
  if (!WINDOW_GLASS_LEVELS.includes(level as WindowGlassLevel)) return null;
  const colors =
    typeof color === 'string' && HEX_COLOR.test(color) &&
    typeof symbolColor === 'string' && HEX_COLOR.test(symbolColor)
      ? { color, symbolColor }
      : undefined;
  return { level: level as WindowGlassLevel, ...(colors ? { colors } : {}) };
}
