import { useStore } from '../stores';
import { listedRailPageNames } from '../plugins/usePlugins';
import {
  defaultBindings,
  effectiveBindings,
  isPluginPageShortcut,
  ShortcutPressGuard,
  type ShortcutBinding,
  type ShortcutOverrides,
} from '../../shared/keymap';

/**
 * The shortcut bindings every renderer keyboard gate reads (#1455).
 *
 * useKeyboard (runs actions), useTerminal (decides which keys leave xterm)
 * and useComposeShortcut (Rich Input) must agree on which keydown is which
 * binding — a key one of them claims and another declines is dead in both
 * worlds. So none of them builds its own view of the keymap: they all call
 * this, which applies the user's overrides to the one table in
 * shared/keymap.ts, memoized on the overrides object the store hands out.
 */

export function shortcutPlatform(): NodeJS.Platform {
  const p = window.electronAPI?.platform;
  return p === 'darwin' || p === 'linux' ? p : 'win32';
}

let cache: {
  platform: NodeJS.Platform;
  overrides: ShortcutOverrides;
  bindings: ShortcutBinding[];
} | null = null;

/** The bindings in force right now: defaults plus the user's overrides. */
export function currentShortcutBindings(): readonly ShortcutBinding[] {
  const platform = shortcutPlatform();
  const overrides = useStore.getState().shortcutOverrides;
  if (!cache || cache.platform !== platform || cache.overrides !== overrides) {
    cache = { platform, overrides, bindings: effectiveBindings(platform, overrides) };
  }
  return cache.bindings;
}

let activeCache: { all: readonly ShortcutBinding[]; pages: ReadonlySet<string>; bindings: ShortcutBinding[] } | null = null;

/**
 * What a key press can run: currentShortcutBindings without the key of a
 * plugin page the rail does not list (removed or denied). Its override stays
 * stored, so Settings can still take it off, but the key reaches the
 * terminal instead of opening a page that is not there.
 */
export function activeShortcutBindings(): readonly ShortcutBinding[] {
  const all = currentShortcutBindings();
  const pages = listedRailPageNames();
  if (!activeCache || activeCache.all !== all || activeCache.pages !== pages) {
    activeCache = {
      all,
      pages,
      bindings: all.filter((b) => !isPluginPageShortcut(b.action) || pages.has(b.action.slice('plugin:'.length))),
    };
  }
  return activeCache.bindings;
}

let defaultsCache: { platform: NodeJS.Platform; bindings: ShortcutBinding[] } | null = null;

/** The bindings wmux ships with, ignoring the user's overrides. */
export function defaultShortcutBindings(): readonly ShortcutBinding[] {
  const platform = shortcutPlatform();
  if (!defaultsCache || defaultsCache.platform !== platform) {
    defaultsCache = { platform, bindings: defaultBindings(platform) };
  }
  return defaultsCache.bindings;
}

/**
 * The one ShortcutPressGuard every gate above shares, so a press one gate
 * acted on is a duplicate for all of them (see shared/keymap.ts). useKeyboard
 * feeds it keyups.
 */
export const shortcutPressGuard = new ShortcutPressGuard();
