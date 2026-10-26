import type { IMarker } from '@xterm/xterm';
import type { UISlice } from '../../stores/slices/uiSlice';

/**
 * Scrollback bookmarks (Ctrl+M) as xterm markers.
 *
 * A marker is the only line reference that survives the buffer moving under
 * it: xterm shifts it when lines are inserted or deleted above it and disposes
 * it when its line is trimmed out of a full scrollback. The store's
 * `terminalBookmarks` lists the marker ids of each pane and is the one record
 * of which bookmarks exist; the markers themselves stay in their xterm
 * Terminal (`term.markers`). A marker never goes into the store, because immer
 * freezes what it holds and a frozen marker can no longer move.
 *
 * The two stay in step both ways: a disposed marker (trimmed, or its Terminal
 * disposed or reset) takes its id out of the store, and an id taken out of the
 * store (clearBookmarks, clearAllPtyState) disposes its marker.
 */

/** The part of an xterm Terminal a bookmark uses; @xterm/headless has it too. */
export interface BookmarkTerminal {
  readonly rows: number;
  /** The active buffer's markers; always empty on the alternate screen. */
  readonly markers: ReadonlyArray<IMarker>;
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly baseY: number;
      readonly viewportY: number;
      readonly cursorY: number;
      readonly length: number;
    };
  };
  registerMarker(cursorYOffset?: number): IMarker;
}

type BookmarkState = Pick<UISlice, 'terminalBookmarks' | 'addBookmark' | 'removeBookmark'>;

export interface BookmarkStore {
  getState(): BookmarkState;
  subscribe(listener: (state: BookmarkState) => void): () => void;
}

/** Bookmark the line `cursorOffset` lines from the cursor's line. */
function track(term: BookmarkTerminal, ptyId: string, store: BookmarkStore, cursorOffset: number): void {
  const marker = term.registerMarker(cursorOffset);
  store.getState().addBookmark(ptyId, marker.id);
  const unsubscribe = store.subscribe((state) => {
    if (!state.terminalBookmarks[ptyId]?.includes(marker.id)) marker.dispose();
  });
  marker.onDispose(() => {
    unsubscribe();
    store.getState().removeBookmark(ptyId, marker.id);
  });
}

function bookmarkMarkers(term: BookmarkTerminal, ids: readonly number[] | undefined): IMarker[] {
  return ids ? term.markers.filter((m) => ids.includes(m.id)) : [];
}

/**
 * Bookmark the top line of the viewport. 'alternate' when a full-screen app's
 * alternate screen is active (it has no scrollback to mark), 'exists' when the
 * line already has a bookmark.
 */
export function addAt(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): 'added' | 'exists' | 'alternate' {
  const buffer = term.buffer.active;
  if (buffer.type === 'alternate') return 'alternate';
  const ids = store.getState().terminalBookmarks[ptyId];
  if (bookmarkMarkers(term, ids).some((m) => m.line === buffer.viewportY)) return 'exists';
  // viewportY is already an absolute buffer line; registerMarker counts from
  // the cursor's absolute line (baseY + cursorY).
  track(term, ptyId, store, buffer.viewportY - (buffer.baseY + buffer.cursorY));
  return 'added';
}

/** The viewport rows (0..rows-1) that hold one of the given bookmarks. */
export function rowsInView(term: BookmarkTerminal, ids: readonly number[]): { id: number; row: number }[] {
  const viewportY = term.buffer.active.viewportY;
  const out: { id: number; row: number }[] = [];
  for (const marker of bookmarkMarkers(term, ids)) {
    const row = marker.line - viewportY;
    if (row >= 0 && row < term.rows) out.push({ id: marker.id, row });
  }
  return out;
}

/**
 * Carry a pane's bookmarks across a repaint that resets the Terminal (RIS
 * disposes every marker) and replays the session. Call it right before the
 * reset; call what it returns once the replay has been parsed. Each bookmark
 * comes back the same number of lines above the cursor, which sits at the end
 * of the output both times; one the shorter replay no longer reaches is
 * dropped, as is every one when the replay ends on the alternate screen.
 */
export function keepAcrossRepaint(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): () => void {
  const before = term.buffer.active;
  const cursorLine = before.baseY + before.cursorY;
  const aboveCursor = bookmarkMarkers(term, store.getState().terminalBookmarks[ptyId])
    .map((m) => cursorLine - m.line);
  return () => {
    const after = term.buffer.active;
    if (after.type === 'alternate') return;
    const cursorLineAfter = after.baseY + after.cursorY;
    const ids = store.getState().terminalBookmarks[ptyId];
    const taken = new Set(bookmarkMarkers(term, ids).map((m) => m.line));
    for (const distance of aboveCursor) {
      const line = cursorLineAfter - distance;
      if (line < 0 || line >= after.length || taken.has(line)) continue;
      taken.add(line);
      track(term, ptyId, store, -distance);
    }
  };
}
