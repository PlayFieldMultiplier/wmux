import type { IMarker } from '@xterm/xterm';
import type { UISlice } from '../../stores/slices/uiSlice';

/**
 * Scrollback bookmarks (Ctrl+M) as xterm markers.
 *
 * A marker is the only line reference that survives the buffer moving under
 * it: xterm shifts it when lines are inserted or deleted above it and disposes
 * it when its line is trimmed out of a full scrollback. This module is the one
 * owner of the markers. The store holds only their ids (`terminalBookmarks`),
 * so a change re-renders the indicator; a marker never goes into the store,
 * because immer freezes what it holds and a frozen marker can no longer move.
 *
 * A marker is disposed with its xterm Terminal (dispose, reset, clear), and its
 * onDispose takes the id out of this map and the store, so closing a pane needs
 * no separate cleanup.
 */

/** The part of an xterm Terminal a bookmark uses; @xterm/headless has it too. */
export interface BookmarkTerminal {
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly baseY: number;
      readonly viewportY: number;
      readonly cursorY: number;
    };
  };
  registerMarker(cursorYOffset?: number): IMarker;
}

export interface BookmarkStore {
  getState(): Pick<UISlice, 'addBookmark' | 'removeBookmark'>;
}

interface Entry {
  marker: IMarker;
  // The instance the marker lives in: a pane remounted with a new Terminal on
  // the same ptyId must not draw the old instance's markers.
  term: BookmarkTerminal;
}

const markersByPty = new Map<string, Map<number, Entry>>();

/**
 * Bookmark the top line of the viewport. Returns false when the alternate
 * screen (a full-screen app) is active: it has no scrollback to mark.
 */
export function addAt(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): boolean {
  const buffer = term.buffer.active;
  if (buffer.type === 'alternate') return false;
  const markers = markersByPty.get(ptyId) ?? new Map<number, Entry>();
  for (const { marker, term: owner } of markers.values()) {
    if (owner === term && marker.line === buffer.viewportY) return true;
  }
  // viewportY is already an absolute buffer line; registerMarker counts from
  // the cursor's absolute line (baseY + cursorY).
  const marker = term.registerMarker(buffer.viewportY - (buffer.baseY + buffer.cursorY));
  markers.set(marker.id, { marker, term });
  markersByPty.set(ptyId, markers);
  marker.onDispose(() => {
    markers.delete(marker.id);
    if (markers.size === 0 && markersByPty.get(ptyId) === markers) markersByPty.delete(ptyId);
    store.getState().removeBookmark(ptyId, marker.id);
  });
  store.getState().addBookmark(ptyId, marker.id);
  return true;
}

/** The viewport rows (0..rows-1) that hold one of the given bookmarks. */
export function rowsInView(
  term: BookmarkTerminal,
  ptyId: string,
  ids: readonly number[],
): { id: number; row: number }[] {
  const buffer = term.buffer.active;
  const markers = markersByPty.get(ptyId);
  if (!markers || buffer.type === 'alternate') return [];
  const out: { id: number; row: number }[] = [];
  for (const id of ids) {
    const entry = markers.get(id);
    if (!entry || entry.term !== term || entry.marker.isDisposed) continue;
    const row = entry.marker.line - buffer.viewportY;
    if (row >= 0 && row < term.rows) out.push({ id, row });
  }
  return out;
}
