// File tree column geometry: pure values and clamps, shared by the store
// (persist/restore), the column's edge handle, the dock-mode measure and the
// tests. Mirrors sidebarLayout.ts.

/** Default column width. Double-clicking the edge handle returns here. */
export const FILE_TREE_DEFAULT_WIDTH = 260;
/** Narrowest drag stop: below this a nested file name no longer survives its indent. */
export const FILE_TREE_MIN_WIDTH = 200;
/** Widest drag stop: past this the column starts competing with the terminals. */
export const FILE_TREE_MAX_WIDTH = 480;

/**
 * Clamp a requested width into the drag range. Anything that is not a finite
 * number (a torn session file, a string) falls back to the default.
 */
export function clampFileTreeWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return FILE_TREE_DEFAULT_WIDTH;
  return Math.round(Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, width)));
}
