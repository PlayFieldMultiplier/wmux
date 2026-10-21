// ─── An HTML page drawn inert, in a frame of its own ───────────────────────
//
// A bot's HTML file, or an ```html block in its message, previewed in the
// Bots page. The page is untrusted, so it is drawn in an <iframe srcdoc>
// that can do nothing but paint:
//
// - `sandbox=""`: no scripts, no same origin (an opaque origin, so it cannot
//   reach the app's document or its `electronAPI`), no forms, no popups, no
//   top navigation. Main's frame guard (attachPluginFrameNavigation) refuses
//   any navigation the frame itself starts, a link or a refresh included;
//   the srcdoc load itself does not reach that guard (checked on Electron
//   41.10.6; a preview that turns blank after an upgrade starts there).
// - A Content-Security-Policy meta as the head's first element: nothing
//   loads from anywhere but the page itself (inline styles, data: images
//   and fonts), so no network request and no tracking pixel.
// - `referrerpolicy="no-referrer"`.

import { useMemo } from 'react';

/** What the page may load: inline styles, data: images and fonts, nothing else. */
export const SANDBOXED_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** `<link rel>` tokens that ask the browser to reach a host ahead of use. */
const RESOURCE_HINTS = new Set(['preconnect', 'dns-prefetch', 'prefetch', 'prerender', 'preload', 'modulepreload']);

/** The page as the frame's srcdoc: parsed inertly (DOMParser runs no script
 *  and loads nothing), without its resource hints or its own http-equiv
 *  metas, and written back with the CSP meta first in its head, so the
 *  policy is in force before anything in the page could load. */
export function sandboxedHtmlDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const link of doc.querySelectorAll('link[rel]')) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.some((token) => RESOURCE_HINTS.has(token))) link.remove();
  }
  for (const own of doc.querySelectorAll('meta[http-equiv]')) own.remove();
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', SANDBOXED_HTML_CSP);
  doc.head.prepend(meta);
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/** An untrusted HTML page, drawn and inert. */
export default function SandboxedHtmlFrame({ html, title, className }: {
  html: string;
  /** The frame's accessible name. */
  title: string;
  className?: string;
}) {
  const srcDoc = useMemo(() => sandboxedHtmlDocument(html), [html]);
  return (
    <iframe
      sandbox=""
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      title={title}
      className={className}
      data-sandboxed-html=""
    />
  );
}
