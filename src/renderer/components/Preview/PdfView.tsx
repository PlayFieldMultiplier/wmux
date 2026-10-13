import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useT } from '../../hooks/useT';
import { formatPreviewBytes } from '../../../shared/filePreview';
import { PreviewFooter, ZoomControls } from './PreviewChrome';
import { fitWidthZoom, wheelZoom } from './previewZoom';

type PdfJs = typeof import('pdfjs-dist');

const PAGE_GAP = 12;
const PAD = 16;

let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js loads the first time a PDF tab opens, never with the app. Its worker
 *  and data files are same-origin files under `pdfjs/` (vite.renderer.config). */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    // Hand pdf.js a worker we start ourselves. Given only a URL, it judges the
    // packaged file:// page (origin "null") cross-origin and wraps the worker
    // in a blob: URL, which the CSP refuses, so every PDF would parse on the
    // main thread beside the terminals. One worker serves every document.
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(pdfjsAsset('build/pdf.worker.min.mjs'), { type: 'module' });
    return pdfjs;
  });
  return pdfjsPromise;
}

/** Largest canvas a page renders into; past it the page renders at a lower
 *  resolution and is scaled up, instead of asking for gigabytes at 2000%. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

function pdfjsAsset(rel: string): string {
  return new URL(`pdfjs/${rel}`, document.baseURI).toString();
}

interface Loaded {
  doc: PDFDocumentProxy;
  /** Page sizes at 100%, in CSS pixels. */
  pages: { width: number; height: number }[];
}

/** Where the reader is: a page and how far down it, so a reload or a zoom lands there again. */
interface Anchor {
  page: number;
  fraction: number;
}

function pageTops(pages: Loaded['pages'], scale: number): number[] {
  const tops: number[] = [];
  let y = PAD;
  for (const p of pages) {
    tops.push(y);
    y += p.height * scale + PAGE_GAP;
  }
  return tops;
}

function anchorAt(scrollTop: number, pages: Loaded['pages'], scale: number): Anchor {
  const tops = pageTops(pages, scale);
  let page = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= scrollTop) page = i;
  const height = (pages[page]?.height ?? 1) * scale;
  return { page, fraction: Math.max(0, Math.min(1, (scrollTop - tops[page]) / height)) };
}

/**
 * Read-only PDF view (#2150): continuous pages, rendered as they scroll into
 * view. When the file changes, the new document loads in the background and
 * replaces the old one only once it parses; the reader stays on the same page
 * and the same spot on it. A broken or half-written file leaves the previous
 * version up, with a notice.
 */
export default function PdfView({ url, size, exists, complete }: { url: string; size: number; exists: boolean; complete: boolean }) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewWidth, setViewWidth] = useState(0);
  /** null = fitted to the viewport width. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const pendingAnchor = useRef<Anchor | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;

  const maxWidth = useMemo(() => Math.max(1, ...(loaded?.pages.map((p) => p.width) ?? [1])), [loaded]);
  const scale = zoom ?? fitWidthZoom(maxWidth, Math.max(1, viewWidth - PAD * 2));
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PdfJs['getDocument']> | null = null;
    // Once shown, the document belongs to the view, which tears it down when
    // the next version replaces it; only a load still in flight is ours to abort.
    let adopted = false;
    loadPdfJs().then(async (pdfjs) => {
      if (cancelled) return;
      task = pdfjs.getDocument({
        url,
        // The whole file in one request: the scheme serves no ranges.
        disableRange: true,
        disableStream: true,
        cMapUrl: pdfjsAsset('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: pdfjsAsset('standard_fonts/'),
        wasmUrl: pdfjsAsset('wasm/'),
        iccUrl: pdfjsAsset('iccs/'),
      });
      const doc = await task.promise;
      const pages: Loaded['pages'] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const viewport = (await doc.getPage(i)).getViewport({ scale: 1 });
        pages.push({ width: viewport.width, height: viewport.height });
      }
      if (cancelled) { void doc.loadingTask.destroy(); return; }
      const previous = loadedRef.current;
      const el = viewportRef.current;
      if (previous && el) pendingAnchor.current = anchorAt(el.scrollTop, previous.pages, scaleRef.current);
      adopted = true;
      setLoaded({ doc, pages });
      setFailed(false);
      if (previous) void previous.doc.loadingTask.destroy();
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (!adopted) void task?.destroy();
    };
  }, [url]);

  useEffect(() => () => { void loadedRef.current?.doc.loadingTask.destroy(); }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Land on the anchor after a reload or a zoom changed the layout.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const anchor = pendingAnchor.current;
    if (!el || !anchor || !loaded) return;
    pendingAnchor.current = null;
    const page = Math.min(anchor.page, loaded.pages.length - 1);
    const tops = pageTops(loaded.pages, scale);
    el.scrollTop = tops[page] + anchor.fraction * loaded.pages[page].height * scale;
  }, [loaded, scale]);

  const zoomTo = (next: number | null) => {
    const el = viewportRef.current;
    if (el && loaded) pendingAnchor.current = anchorAt(el.scrollTop, loaded.pages, scale);
    setZoom(next);
  };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomToRef.current(wheelZoom(scaleRef.current, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const tops = loaded ? pageTops(loaded.pages, scale) : [];
  const totalHeight = loaded
    ? tops[tops.length - 1] + loaded.pages[loaded.pages.length - 1].height * scale + PAD
    : 0;

  const goToPage = (index: number) => {
    const el = viewportRef.current;
    if (!el || !loaded) return;
    const page = Math.max(0, Math.min(loaded.pages.length - 1, index));
    el.scrollTop = tops[page] - PAD / 2;
  };

  const info = loaded
    ? `${t('preview.pageCount', { count: loaded.pages.length })} · ${formatPreviewBytes(size)} · PDF`
    : `${formatPreviewBytes(size)} · PDF`;
  const notice = !exists ? t('preview.waiting') : (!complete || failed) && loaded ? t('preview.updateFailed') : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 overflow-auto bg-[var(--bg-mantle)]"
        data-preview-viewport
        onScroll={(e) => {
          if (!loaded) return;
          setCurrentPage(anchorAt(e.currentTarget.scrollTop + e.currentTarget.clientHeight / 3, loaded.pages, scale).page);
        }}
      >
        {loaded ? (
          <div className="relative mx-auto" style={{ height: totalHeight, width: Math.max(maxWidth * scale + PAD * 2, 1) }}>
            {loaded.pages.map((p, i) => (
              <PdfPage
                key={i}
                doc={loaded.doc}
                index={i}
                top={tops[i]}
                width={p.width * scale}
                height={p.height * scale}
                left={(maxWidth - p.width) * scale / 2 + PAD}
                scale={scale}
                root={viewportRef}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
            {failed ? t('preview.error.load') : t('preview.loading')}
          </div>
        )}
      </div>
      <PreviewFooter info={info} notice={notice}>
        {loaded && (
          <>
            <PageField page={currentPage} count={loaded.pages.length} onGo={goToPage} />
            <ZoomControls zoom={scale} fitted={zoom === null} onZoom={(next) => zoomTo(next)} onFit={() => zoomTo(null)} />
          </>
        )}
      </PreviewFooter>
    </div>
  );
}

function PageField({ page, count, onGo }: { page: number; count: number; onGo: (index: number) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums" data-preview-page>
      <input
        type="text"
        inputMode="numeric"
        className="w-[36px] h-[22px] px-1 text-center text-[11px] rounded-[5px] bg-transparent text-[var(--text-main)] hover:bg-[var(--hover-fill)] focus:bg-[var(--bg-surface)] outline-none"
        value={draft ?? String(page + 1)}
        aria-label={t('preview.pageField')}
        onFocus={(e) => { setDraft(String(page + 1)); e.currentTarget.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number.parseInt(draft ?? '', 10);
            if (Number.isFinite(n)) onGo(n - 1);
            setDraft(null);
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }}
      />
      <span>/ {count}</span>
    </label>
  );
}

/** One page: a sized box always, a canvas only while it is near the viewport. */
function PdfPage({ doc, index, top, left, width, height, scale, root }: {
  doc: PDFDocumentProxy;
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: root.current, rootMargin: '600px 0px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let rendered: { cleanup: () => boolean } | null = null;
    doc.getPage(index + 1).then((page) => {
      if (cancelled) return;
      rendered = page;
      const dpr = window.devicePixelRatio || 1;
      const base = page.getViewport({ scale: 1 });
      const wanted = scale * dpr;
      const cap = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, base.width * base.height));
      const viewport = page.getViewport({ scale: Math.min(wanted, cap) });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      return task.promise;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      // Off screen (or re-rendering at a new zoom): let pdf.js drop the page's
      // decoded images, so a long scanned PDF does not pile up memory.
      rendered?.cleanup();
    };
  }, [doc, index, scale, near]);

  return (
    <div
      ref={boxRef}
      className="absolute bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
      style={{ top, left, width, height }}
      data-preview-page-index={index}
    >
      {near && <canvas ref={canvasRef} className="block w-full h-full" />}
    </div>
  );
}
