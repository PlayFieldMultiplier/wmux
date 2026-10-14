// Zoom arithmetic shared by the image and PDF previews (#2150). Pure, so the
// rules the toolbar promises are testable without a DOM.

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 20;
/** One click of − / + multiplies or divides by this. */
export const ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The scale that shows the whole image in the viewport. Never above 100%: a
 * small icon stays its real size instead of being blown up into a blur.
 */
export function fitImageZoom(contentW: number, contentH: number, viewW: number, viewH: number): number {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return 1;
  return clampZoom(Math.min(1, viewW / contentW, viewH / contentH));
}

/** A PDF page fits by width (pages are read top to bottom), and may grow. */
export function fitWidthZoom(pageW: number, viewW: number): number {
  if (pageW <= 0 || viewW <= 0) return 1;
  return clampZoom(viewW / pageW);
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP);
}

/** Cmd/Ctrl + wheel: a smooth factor from the wheel delta (trackpad or mouse). */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.002));
}

/**
 * Keep the content point under the cursor still across a zoom: the new
 * scroll offset for one axis. `cursor` is relative to the viewport's edge.
 */
export function scrollForZoomAt(scroll: number, cursor: number, from: number, to: number): number {
  if (from <= 0) return scroll;
  return Math.max(0, ((scroll + cursor) / from) * to - cursor);
}

/** "125%" — what the zoom field shows. */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Parse what someone typed into the zoom field ("150", "150%", " 80 % "). */
export function parseZoomInput(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
  if (!match) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampZoom(percent / 100);
}
