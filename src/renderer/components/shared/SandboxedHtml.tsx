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
//   loads from anywhere but the page itself (inline styles, data: images),
//   so no network request and no tracking pixel. A srcdoc frame also keeps
//   the app window's own policy, so data: fonts load only where that allows
//   them (the packaged app's `font-src 'self'` does not).
// - No resource hints (`<link rel=preconnect>` and the like, which a CSP
//   does not cover) and none of the page's own http-equiv metas. Markup can
//   parse differently once written back, so the written page is parsed
//   again and checked; one that does not settle is not previewed.
// - `referrerpolicy="no-referrer"`.
//
// Focus: a click in the page moves the focus into the frame, and the app's
// keys (Escape included) reach it again only after a click outside.

/** What the page may load: inline styles, data: images and fonts, nothing
 *  else (the window's own policy still applies on top: no data: fonts in the
 *  packaged app). */
export const SANDBOXED_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** `<link rel>` tokens that ask the browser to reach a host ahead of use. */
const RESOURCE_HINTS = new Set(['preconnect', 'dns-prefetch', 'prefetch', 'prerender', 'preload', 'modulepreload']);

/** Rounds of strip-and-write before a page that keeps changing is refused. */
const MAX_ROUNDS = 3;

function isHint(link: Element): boolean {
  return (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).some((token) => RESOURCE_HINTS.has(token));
}

/** The page written back without hints or its own http-equiv metas, with
 *  the CSP meta first in its head. */
function strip(doc: Document): string {
  for (const link of doc.querySelectorAll('link')) if (isHint(link)) link.remove();
  for (const own of doc.querySelectorAll('meta[http-equiv]')) own.remove();
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', SANDBOXED_HTML_CSP);
  doc.head.prepend(meta);
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/** Whether a written page, parsed as the frame will parse it, holds no hint
 *  and exactly one http-equiv meta: the CSP, first in the head. */
function settled(doc: Document): boolean {
  if ([...doc.querySelectorAll('link')].some(isHint)) return false;
  const metas = doc.querySelectorAll('meta[http-equiv]');
  const first = doc.head.firstElementChild;
  return metas.length === 1 && metas[0] === first
    && first.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy'
    && first.getAttribute('content') === SANDBOXED_HTML_CSP;
}

/** The page as the frame's srcdoc, or null when it cannot be made safe to
 *  preview (show its source instead). Parsing is inert: DOMParser runs no
 *  script and loads nothing. */
export function sandboxedHtmlDocument(html: string): string | null {
  const parse = (s: string) => new DOMParser().parseFromString(s, 'text/html');
  let out = strip(parse(html));
  for (let round = 1; round < MAX_ROUNDS; round++) {
    const again = parse(out);
    if (settled(again)) return out;
    out = strip(again);
  }
  return settled(parse(out)) ? out : null;
}

/** An untrusted HTML page, drawn and inert. `srcDoc` is sandboxedHtmlDocument's. */
export default function SandboxedHtmlFrame({ srcDoc, title, className }: {
  srcDoc: string;
  /** The frame's accessible name. */
  title: string;
  className?: string;
}) {
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
