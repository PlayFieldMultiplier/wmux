import { useEffect, useState, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import { rowsInView } from './scrollbackBookmarks';

interface BookmarkIndicatorProps {
  terminal: Terminal | null;
  ptyId: string | null;
  bookmarks: number[]; // ids of the xterm markers (scrollbackBookmarks.ts)
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Renders small colored markers on the left edge of the terminal container
 * on the lines where bookmarks were created.
 *
 * Each bookmark is an xterm marker that follows its line as the buffer
 * changes; rowsInView turns it into a viewport row:
 *
 *   row      = marker.line - term.buffer.active.viewportY
 *   pixelTop = row * lineHeight
 *
 * Lines outside the current viewport are not rendered (the marker would be
 * off-screen). We re-compute on every scroll event so markers track correctly
 * as the user scrolls.
 */
export default function BookmarkIndicator({ terminal, ptyId, bookmarks, containerRef }: BookmarkIndicatorProps) {
  // Re-render whenever the terminal scrolls or the bookmarks list changes
  const [, forceUpdate] = useState(0);

  const scheduleUpdate = useCallback(() => {
    forceUpdate((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!terminal) return;
    const disposable = terminal.onScroll(() => scheduleUpdate());
    return () => disposable.dispose();
  }, [terminal, scheduleUpdate]);

  // Also re-render when bookmarks array reference changes (handled by the
  // parent passing a new array reference via Zustand selector)

  if (!terminal || !ptyId || bookmarks.length === 0) return null;

  const container = containerRef.current;
  if (!container) return null;

  const rows = terminal.rows;
  if (rows <= 0) return null;

  // Compute pixel height per terminal row
  const termElement = terminal.element;
  if (!termElement) return null;

  // The xterm .xterm-screen element holds the actual character grid
  const screenEl = termElement.querySelector('.xterm-screen') as HTMLElement | null;
  const lineHeight = screenEl ? screenEl.offsetHeight / rows : container.offsetHeight / rows;
  if (lineHeight <= 0) return null;

  const markers = rowsInView(terminal, ptyId, bookmarks).map(({ id, row }) => ({
    top: row * lineHeight + lineHeight / 2 - 4, // center the 8px dot vertically in the row
    id,
  }));

  return (
    <>
      {markers.map(({ top, id }) => (
        <div
          key={id}
          style={{
            position: 'absolute',
            left: 2,
            top,
            width: 6,
            height: 8,
            borderRadius: 2,
            background: 'var(--accent-yellow)',
            opacity: 0.85,
            zIndex: 20,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
