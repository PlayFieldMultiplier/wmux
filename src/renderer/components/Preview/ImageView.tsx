import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { formatPreviewBytes } from '../../../shared/filePreview';
import { PreviewFooter, ZoomControls } from './PreviewChrome';
import { fitImageZoom, scrollForZoomAt, wheelZoom } from './previewZoom';

/** Matches the `p-4` around the image. */
const VIEW_PAD = 16;

interface Shown {
  url: string;
  width: number;
  height: number;
}

/**
 * Read-only image view (#2150). The wheel scrolls (pans); Cmd/Ctrl + wheel
 * and the toolbar zoom, around the cursor; a drag pans. It opens fitted —
 * never above 100% — and stays fitted until someone zooms.
 *
 * A new version is decoded off screen first and swapped in only once it
 * loads, and main holds back a file whose end marker is missing, so a
 * half-written file never tears or blanks the view: the last good image
 * stays, with a notice, until a complete one arrives. Zoom and scroll carry
 * over the swap.
 */
export default function ImageView({ url, size, format, exists, complete }: {
  url: string;
  size: number;
  format: string;
  exists: boolean;
  complete: boolean;
}) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ width: 0, height: 0 });
  /** null = fitted to the viewport. */
  const [zoom, setZoom] = useState<number | null>(null);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.src = url;
    img.decode().then(() => {
      if (cancelled) return;
      // An SVG without a size reports 0; give it a sensible canvas.
      const width = img.naturalWidth || 512;
      const height = img.naturalHeight || 512;
      setShown({ url, width, height });
      setFailed(false);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setView({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit inside the padding around the image, or a fitted image always scrolls.
  const scale = shown
    ? zoom ?? fitImageZoom(shown.width, shown.height, view.width - VIEW_PAD * 2, view.height - VIEW_PAD * 2)
    : 1;

  const applyZoom = (next: number, cursor?: { x: number; y: number }) => {
    const el = viewportRef.current;
    if (!el || !shown) { setZoom(next); return; }
    const cx = cursor?.x ?? el.clientWidth / 2;
    const cy = cursor?.y ?? el.clientHeight / 2;
    pendingScroll.current = {
      left: scrollForZoomAt(el.scrollLeft, cx, scale, next),
      top: scrollForZoomAt(el.scrollTop, cy, scale, next),
    };
    setZoom(next);
  };

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const target = pendingScroll.current;
    if (!el || !target) return;
    pendingScroll.current = null;
    el.scrollLeft = target.left;
    el.scrollTop = target.top;
  }, [scale]);

  // Cmd/Ctrl + wheel zooms; it needs a non-passive listener to stop the page zoom.
  const zoomRef = useRef(applyZoom);
  zoomRef.current = applyZoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomRef.current(wheelZoom(scaleRef.current, e.deltaY), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const overflowing = shown !== null
    && (shown.width * scale + VIEW_PAD * 2 > view.width + 1 || shown.height * scale + VIEW_PAD * 2 > view.height + 1);
  const info = shown
    ? `${shown.width}×${shown.height} · ${formatPreviewBytes(size)} · ${format}`
    : `${formatPreviewBytes(size)} · ${format}`;
  const notice = !exists ? t('preview.waiting') : (!complete || failed) && shown ? t('preview.updateFailed') : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={viewportRef}
        className={`relative flex-1 min-h-0 overflow-auto ${overflowing ? 'cursor-grab active:cursor-grabbing' : ''}`}
        data-preview-viewport
        onPointerDown={(e) => {
          if (e.button !== 0 || !overflowing) return;
          const el = e.currentTarget;
          drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
          e.currentTarget.scrollTop = d.top - (e.clientY - d.y);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        {shown ? (
          <div className="grid place-items-center min-w-full min-h-full w-max h-max p-4">
            <div
              className="wmux-preview-checker"
              style={{ width: shown.width * scale, height: shown.height * scale }}
            >
              <img
                src={shown.url}
                alt=""
                draggable={false}
                className="block w-full h-full select-none"
                data-preview-image
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
            {failed ? t('preview.error.load') : t('preview.loading')}
          </div>
        )}
      </div>
      <PreviewFooter info={info} notice={notice}>
        {shown && (
          <ZoomControls
            zoom={scale}
            fitted={zoom === null}
            onZoom={(next) => applyZoom(next)}
            onFit={() => setZoom(null)}
          />
        )}
      </PreviewFooter>
    </div>
  );
}
