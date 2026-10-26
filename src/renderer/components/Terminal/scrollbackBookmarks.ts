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
 * store (clearBookmarks, clearAllPtyState) disposes its marker
 * (watchScrollbackBookmarks).
 */

interface BookmarkLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

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
      getLine(y: number): BookmarkLine | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): IMarker;
}

type BookmarkState = Pick<UISlice, 'terminalBookmarks' | 'addBookmark' | 'removeBookmark' | 'setBookmarks'>;

export interface BookmarkStore {
  getState(): BookmarkState;
}

/** A marker `cursorOffset` lines from the cursor's line, whose disposal takes
 *  its id out of the store. The caller puts the id in. */
function register(term: BookmarkTerminal, ptyId: string, store: BookmarkStore, cursorOffset: number): IMarker {
  const marker = term.registerMarker(cursorOffset);
  marker.onDispose(() => store.getState().removeBookmark(ptyId, marker.id));
  return marker;
}

function bookmarkMarkers(term: BookmarkTerminal, ids: readonly number[] | undefined): IMarker[] {
  return ids ? term.markers.filter((m) => ids.includes(m.id)) : [];
}

/** The whole logical line `y` belongs to, wrapped rows joined. */
function logicalText(term: BookmarkTerminal, y: number): string | undefined {
  const buffer = term.buffer.active;
  if (!buffer.getLine(y)) return undefined;
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let text = '';
  for (let row = start; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    const next = buffer.getLine(row + 1);
    text += line.translateToString(!next?.isWrapped);
  }
  return text;
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
  const marker = register(term, ptyId, store, buffer.viewportY - (buffer.baseY + buffer.cursorY));
  store.getState().addBookmark(ptyId, marker.id);
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
 * reset; call what it returns once the replay has been parsed.
 *
 * A bookmark comes back only on a line it provably still is: the same number
 * of lines above the cursor (which sits at the end of the output both times)
 * and the same text. Otherwise it is dropped, never moved to another line:
 * output that arrived while the pane was hidden or a reflow to another width
 * changes what sits there. None survive a repaint that starts or ends on the
 * alternate screen, whose markers the public API cannot reach.
 *
 * The store changes twice whatever the number of bookmarks: the ids go out
 * here, and the restored ones come back in one set.
 */
export function keepAcrossRepaint(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): () => void {
  const before = term.buffer.active;
  const cursorLine = before.baseY + before.cursorY;
  const carried = before.type === 'alternate'
    ? []
    : bookmarkMarkers(term, store.getState().terminalBookmarks[ptyId])
      .map((m) => ({ marker: m, aboveCursor: cursorLine - m.line, text: logicalText(term, m.line) }));
  if (store.getState().terminalBookmarks[ptyId]) store.getState().setBookmarks(ptyId, []);
  for (const { marker } of carried) marker.dispose();
  return () => {
    const after = term.buffer.active;
    if (carried.length === 0 || after.type === 'alternate') return;
    const cursorLineAfter = after.baseY + after.cursorY;
    const ids = store.getState().terminalBookmarks[ptyId] ?? [];
    const taken = new Set(bookmarkMarkers(term, ids).map((m) => m.line));
    const restored: number[] = [];
    for (const { aboveCursor, text } of carried) {
      const line = cursorLineAfter - aboveCursor;
      if (line < 0 || line >= after.length || taken.has(line)) continue;
      if (text === undefined || logicalText(term, line) !== text) continue;
      taken.add(line);
      restored.push(register(term, ptyId, store, -aboveCursor).id);
    }
    if (restored.length > 0) store.getState().setBookmarks(ptyId, [...ids, ...restored]);
  };
}

/**
 * Dispose the marker of every id the store drops (clearBookmarks,
 * clearAllPtyState), when its pane's Terminal is still reachable. One
 * subscription for the app; returns the teardown.
 */
export function watchScrollbackBookmarks(
  store: { subscribe(listener: (state: BookmarkState, prev: BookmarkState) => void): () => void },
  terminalFor: (ptyId: string) => BookmarkTerminal | undefined,
): () => void {
  return store.subscribe((state, prev) => {
    if (state.terminalBookmarks === prev.terminalBookmarks) return;
    for (const [ptyId, before] of Object.entries(prev.terminalBookmarks)) {
      const after = state.terminalBookmarks[ptyId];
      if (after === before) continue;
      const dropped = before.filter((id) => !after?.includes(id));
      if (dropped.length === 0) continue;
      const term = terminalFor(ptyId);
      if (term) for (const marker of bookmarkMarkers(term, dropped)) marker.dispose();
    }
  });
}
