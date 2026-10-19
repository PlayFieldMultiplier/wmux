// ─── SVG drawing size: whether an SVG may show as a picture ─────────────
//
// Nested <use> or an embedded SVG document can make a small SVG draw far
// more than its size suggests. The bot file panel (Bots/BotsFiles.tsx) and
// the file Preview tab (Preview/SvgView.tsx) show such an SVG as its source
// text instead of a picture.

/** Elements <use> may add to an SVG's drawing for it to show as a picture. */
export const SVG_USE_DRAWN_MAX = 50_000;

/** A fragment as the id it names: Blink decodes %-escapes in it. */
function fragmentId(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** Elements <use> adds to an SVG's drawing, counted up to just past
 *  SVG_USE_DRAWN_MAX. Nested <use> multiplies, so a small file can draw a
 *  very large number of elements. Each element is counted once and its
 *  total reused, so this is linear. */
export function svgUseDrawn(text: string): number {
  // No "use" anywhere (any prefix, any case): nothing to expand, no parse.
  if (!/use/i.test(text)) return 0;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const all = doc.getElementsByTagName('*');
  const ids = new Map<string, Element>();
  for (const el of all) if (el.id && !ids.has(el.id)) ids.set(el.id, el);
  const cap = all.length + SVG_USE_DRAWN_MAX + 1;
  const memo = new Map<Element, number>();
  const count = (el: Element): number => {
    const known = memo.get(el);
    if (known !== undefined) return known;
    memo.set(el, 0); // a reference cycle draws nothing
    let n = 1;
    if (el.localName === 'use') {
      const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      const target = href.startsWith('#') ? ids.get(fragmentId(href.slice(1))) : undefined;
      if (target) n += count(target);
    }
    for (const child of el.children) {
      if (n >= cap) break;
      n += count(child);
    }
    n = Math.min(n, cap);
    memo.set(el, n);
    return n;
  };
  return count(doc.documentElement) - all.length;
}

/** Whether an SVG embeds another SVG document (a data: URL in an attribute
 *  or a style), whose drawing svgUseDrawn does not count. Checked on the
 *  parsed document, so character references are already decoded; a style
 *  with a CSS escape counts as embedding, since an escape can spell one. */
export function svgEmbedsSvg(text: string): boolean {
  if (!/data|&#|\\/i.test(text)) return false;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const names = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  for (const el of doc.getElementsByTagName('*')) {
    for (const attr of el.attributes) {
      const value = names(attr.value);
      if (value.includes('data:image/svg')) return true;
      if (attr.localName === 'style' && value.includes('\\')) return true;
    }
    if (el.localName === 'style') {
      const css = names(el.textContent ?? '');
      if (css.includes('data:image/svg') || css.includes('\\')) return true;
    }
  }
  return false;
}

/** Whether an SVG draws too much to show as a picture (it reads as text). */
export function svgDrawsTooMuch(text: string): boolean {
  try {
    return svgEmbedsSvg(text) || svgUseDrawn(text) > SVG_USE_DRAWN_MAX;
  } catch {
    return true; // nested too deep to count
  }
}
