// Whether the OS draws the app window with rounded corners. The sheet (the
// rounded panel that holds the sidebar and the panes, DESIGN.md "Window: frame
// and sheet") sits flush with the window's edges only when it does: in a
// square window corner a flush rounded sheet would leave a frame notch, so
// those windows keep the --sheet-inset margin.

/**
 * First Windows build whose desktop window manager rounds top-level window
 * corners (Windows 11 RTM, 21H2). Windows 10 builds stop at 19045.
 */
export const WINDOWS_ROUNDED_CORNERS_MIN_BUILD = 22000;

/**
 * macOS windows are always rounded. Windows is rounded on build 22000 and
 * later, given the build from `parseWindowsBuildNumber` (shared/platform.ts);
 * an unread build counts as square, so an unknown Windows keeps the inset.
 * Linux corners depend on the window manager and cannot be read, so they count
 * as square.
 *
 * Pure and free of `process`: the sandboxed renderer calls it with the
 * preload's `platform` and `windowsBuildNumber`.
 */
export function hasRoundedWindowCorners(platform: string | undefined, windowsBuild: number | null | undefined): boolean {
  if (platform === 'darwin') return true;
  if (platform !== 'win32') return false;
  return typeof windowsBuild === 'number' && windowsBuild >= WINDOWS_ROUNDED_CORNERS_MIN_BUILD;
}
