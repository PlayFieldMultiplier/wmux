// Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src/features/settings/model/appearance.ts), MIT License, Copyright (c) 2026 Nick
//
// Window glass follows the window, not just the platform: it is on only where
// main gives the window a material (the vibrancy material on macOS, acrylic on
// Windows 11 22H2+; isWindowGlassSupported), only while the theme opts in and
// the user has not turned it off, and only while the app's appearance matches
// the theme. The material follows the app's appearance, so the renderer asks
// main to set that appearance from the theme (dark theme, dark material; light
// theme, light material) and turns glass on once the two agree. The flag is a
// `data-glass` attribute on <html>; globals.css turns the frame and the
// sidebar translucent under it while the panes stay opaque. On Windows the
// renderer also sends the level, so main switches the material at runtime.
import { isLight } from '../tailwindPalette';
import {
  DEFAULT_WINDOW_GLASS,
  isWindowGlassSupported,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';
import { overlayColors } from './titlebarOverlay';

export {
  DEFAULT_WINDOW_GLASS,
  WINDOW_GLASS_LEVELS,
  resolveWindowGlass,
  type WindowGlassLevel,
} from '../../shared/windowGlass';

/** Whether this window can show glass: the preload's platform and Windows build. */
export function windowGlassSupported(): boolean {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  return isWindowGlassSupported(api?.platform, api?.windowsBuildNumber);
}

/** The theme's polarity from its base colour, or null while it cannot be read. */
export function themeAppearance(bgBase: string): 'dark' | 'light' | null {
  const hex = bgBase.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return isLight(hex) ? 'light' : 'dark';
}

export function shouldUseGlass(
  platform: string | undefined,
  bgBase: string,
  themeGlass = '1',
  systemDark = true,
  level: WindowGlassLevel = DEFAULT_WINDOW_GLASS,
  windowsBuild: number | null = null,
): boolean {
  if (!isWindowGlassSupported(platform, windowsBuild) || level === 'off') return false;
  // A theme can opt out of translucency (THEME_STYLES.glass → --theme-glass).
  if (themeGlass.trim() === '0') return false;
  const appearance = themeAppearance(bgBase);
  if (!appearance) return false;
  // Until the material matches the theme, a light material would wash out a
  // dark frame (and the reverse), so the frame stays opaque.
  return (appearance === 'dark') === systemDark;
}

interface SyncState {
  /** The appearance last sent to main. */
  appearance: string | null;
  /** The glass level last sent to main (Windows). */
  level: WindowGlassLevel | null;
}

function sync(root: HTMLElement, systemDark: boolean, last: SyncState): void {
  const style = getComputedStyle(root);
  const platform = window.electronAPI?.platform;
  const windowsBuild = window.electronAPI?.windowsBuildNumber ?? null;
  const supported = isWindowGlassSupported(platform, windowsBuild);
  const bgBase = style.getPropertyValue('--bg-base');
  const appearance = themeAppearance(bgBase);
  const level = resolveWindowGlass(root.getAttribute('data-glass-level'));
  // With glass off the app goes back to the system appearance: overriding it
  // is app-wide (native menus, the in-app browser's prefers-color-scheme),
  // so it is only worth it while the material shows.
  const wanted = level === 'off' ? 'system' : appearance;
  if (supported && wanted && wanted !== last.appearance) {
    last.appearance = wanted;
    window.electronAPI?.window?.setAppearance?.(wanted);
  }
  const on = shouldUseGlass(platform, bgBase, style.getPropertyValue('--theme-glass') || '1', systemDark, level, windowsBuild);
  // The value is the material's appearance, so CSS can tune a light material.
  if (on && appearance) root.setAttribute('data-glass', appearance);
  else root.removeAttribute('data-glass');
  // Windows switches the material at runtime (macOS keeps its vibrancy and
  // lets the page decide). Sent after `data-glass` moved, so the overlay pair
  // is the frame's paint for this level: the solid colour main restores when
  // glass goes off.
  if (platform === 'win32' && supported && level !== last.level) {
    last.level = level;
    window.electronAPI?.window?.setGlass?.({ level, ...(overlayColors() ?? {}) });
  }
}

/** Keep `data-glass` and the app's appearance in step with the theme, the glass level and the appearance. */
export function installWindowGlass(root: HTMLElement = document.documentElement): () => void {
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const last: SyncState = { appearance: null, level: null };
  const run = () => sync(root, scheme ? scheme.matches : true, last);
  run();
  const observer = new MutationObserver(run);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-glass-level'] });
  scheme?.addEventListener?.('change', run);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener?.('change', run);
  };
}
