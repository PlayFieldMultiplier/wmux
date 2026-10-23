// #2372 — `daemon.setSessionViewerVisibility` with `updates` sets several
// panes' visibility in one call. A reloaded window reports every pane twice
// (on mount, and again after its reattach), so one call per report filled the
// daemon's per-second budget.

/** Most panes one batched call may name. */
export const VIEWER_VISIBILITY_BATCH_MAX = 256;

export interface ViewerVisibilityUpdate { id: string; visible: boolean }

/**
 * The updates of a batched call, checked. Throws on anything but an array of
 * 1..VIEWER_VISIBILITY_BATCH_MAX `{ id: string, visible: boolean }`.
 */
export function viewerVisibilityUpdates(raw: unknown): ViewerVisibilityUpdate[] {
  const ok = Array.isArray(raw) && raw.length > 0 && raw.length <= VIEWER_VISIBILITY_BATCH_MAX
    && raw.every((u) => !!u && typeof u === 'object' && typeof (u as ViewerVisibilityUpdate).id === 'string'
      && typeof (u as ViewerVisibilityUpdate).visible === 'boolean');
  if (!ok) {
    throw new Error(`setSessionViewerVisibility: updates must be 1..${VIEWER_VISIBILITY_BATCH_MAX} { id: string, visible: boolean }`);
  }
  return (raw as ViewerVisibilityUpdate[]).map((u) => ({ id: u.id, visible: u.visible }));
}
