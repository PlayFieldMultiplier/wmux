// ─── File tree edge resize handle ────────────────────────────────────────────
//
// Drag the column's inner edge to resize it (200–480px), double-click to go
// back to 260px, arrow keys when focused. Persisted through the store.
//
// Same contract as SidebarResizeHandle: the layout does NOT follow the
// pointer. While dragging only a 1px guide is drawn; the width is committed
// once, on release, so the terminals beside the column refit once instead of
// sending a PTY resize per pointer move.

import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH,
  FILE_TREE_MIN_WIDTH,
  clampFileTreeWidth,
} from '../../utils/fileTreeLayout';

/**
 * Pure: the width a drag lands on. `position` is the window edge the column
 * sits on; on the right its inner edge is the LEFT one, so moving left widens.
 */
export function fileTreeWidthForDrag(startWidth: number, deltaX: number, position: 'left' | 'right'): number {
  return clampFileTreeWidth(startWidth + (position === 'right' ? -deltaX : deltaX));
}

const KEY_STEP = 16;

export default function FileTreeResizeHandle({ position }: { position: 'left' | 'right' }) {
  const t = useT();
  const width = useStore((s) => s.fileTreeWidth);
  const setWidth = useStore((s) => s.setFileTreeWidth);
  const drag = useRef<{ startX: number; startWidth: number; edgeX: number } | null>(null);
  const [guideX, setGuideX] = useState<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const rect = e.currentTarget.parentElement?.getBoundingClientRect();
    const edgeX = rect ? (position === 'right' ? rect.left : rect.right) : e.clientX;
    drag.current = { startX: e.clientX, startWidth: width, edgeX };
    setGuideX(edgeX);
  }, [position, width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = fileTreeWidthForDrag(d.startWidth, e.clientX - d.startX, position) - d.startWidth;
    setGuideX(position === 'right' ? d.edgeX - delta : d.edgeX + delta);
  }, [position]);

  /** A cancelled gesture ends the drag WITHOUT committing. */
  const abort = useCallback(() => {
    drag.current = null;
    setGuideX(null);
  }, []);

  const finish = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setGuideX(null);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const next = fileTreeWidthForDrag(d.startWidth, e.clientX - d.startX, position);
    if (next !== d.startWidth) setWidth(next);
  }, [position, setWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = position === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const shrink = position === 'right' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) setWidth(width + KEY_STEP);
    else if (e.key === shrink) setWidth(width - KEY_STEP);
    else if (e.key === 'Home') setWidth(FILE_TREE_MIN_WIDTH);
    else if (e.key === 'End') setWidth(FILE_TREE_MAX_WIDTH);
    else if (e.key === 'Enter') setWidth(FILE_TREE_DEFAULT_WIDTH);
    else return;
    e.preventDefault();
  }, [position, setWidth, width]);

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('filetree.resize')}
        title={t('filetree.resize')}
        aria-valuemin={FILE_TREE_MIN_WIDTH}
        aria-valuemax={FILE_TREE_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        data-file-tree-resize
        // Straddles the seam, like the sidebar's handle.
        className={`absolute top-0 bottom-0 z-20 w-[10px] cursor-col-resize outline-none focus-visible:bg-[color-mix(in_srgb,var(--accent-blue)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent-blue)_18%,transparent)] transition-colors duration-150 ${position === 'right' ? '-left-1' : '-right-1'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={abort}
        onLostPointerCapture={abort}
        onDoubleClick={() => setWidth(FILE_TREE_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
      />
      {guideX !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed top-0 bottom-0 z-[var(--z-popover-top)] w-px bg-[var(--accent-blue)]"
          style={{ left: guideX }}
          data-file-tree-resize-guide
        />
      )}
    </>
  );
}
