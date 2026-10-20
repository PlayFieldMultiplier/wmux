// The window glass level, shared by main (which builds the Windows window's
// background material from the persisted level) and the renderer (which tints
// the frame and the sidebar over that material).

export type WindowGlassLevel = 'off' | 'soft' | 'clear';
export const WINDOW_GLASS_LEVELS: readonly WindowGlassLevel[] = ['off', 'soft', 'clear'];
export const DEFAULT_WINDOW_GLASS: WindowGlassLevel = 'soft';

/** Persisted values are whitelisted on load; anything else is the default. */
export function resolveWindowGlass(value: unknown): WindowGlassLevel {
  return WINDOW_GLASS_LEVELS.includes(value as WindowGlassLevel) ? value as WindowGlassLevel : DEFAULT_WINDOW_GLASS;
}

/**
 * First Windows build with the system backdrop materials (Windows 11 22H2).
 * Electron's `backgroundMaterial` / `setBackgroundMaterial` do nothing below it.
 */
export const WINDOWS_GLASS_MIN_BUILD = 22621;

/**
 * Whether this OS can show window glass. macOS always can (the vibrancy
 * material). Windows can on 22H2+ (the acrylic backdrop), given the build
 * number from `parseWindowsBuildNumber` (shared/platform.ts); an unread build
 * counts as unsupported, so an unknown Windows keeps the opaque window. Linux
 * never can.
 *
 * Main passes `os.release()`'s build and the renderer the preload's
 * `windowsBuildNumber`, so both sides apply the same rule. It lives here, free
 * of `process`, because the sandboxed renderer imports it.
 */
export function isWindowGlassSupported(platform: string | undefined, windowsBuild: number | null | undefined): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'win32') return false;
  return typeof windowsBuild === 'number' && windowsBuild >= WINDOWS_GLASS_MIN_BUILD;
}
