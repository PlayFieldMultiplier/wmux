// ─── Files a bot attached to its card: how the side panel shows one ──────
//
// Pure helpers for BotsFiles.tsx: which view a file gets (by its media type,
// the name's extension when the type is generic), and how much text the
// panel draws. Main serves the room's stored copy only (ROOM_FILE_READ):
// text as UTF-8 text, everything else as a data URL. An HTML page reads as
// its text; an SVG shows only as an <img>; a file that is neither text nor
// a picture gets Save a copy.

import type { RoomFile } from '../../../shared/roomFiles';

export type FileViewKind = 'markdown' | 'text' | 'image' | 'svg' | 'other';

const MARKDOWN_EXT = /\.(?:md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
const TEXT_EXT = /\.(?:txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|diff|patch|sh|bash|zsh|ps1|bat|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|js|jsx|mjs|cjs|ts|tsx|css|scss|sql|graphql|proto|env|cfg|conf)$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set([
  'application/json', 'application/xml', 'application/xhtml+xml', 'application/javascript', 'application/x-javascript',
  'application/typescript', 'application/x-yaml', 'application/yaml', 'application/toml',
  'application/x-sh', 'application/sql', 'application/x-ndjson',
]);

/** The view a file gets in the side panel. */
export function fileViewKind(file: Pick<RoomFile, 'name' | 'mediaType'>): FileViewKind {
  const type = file.mediaType.split(';')[0].trim().toLowerCase();
  if (type === 'text/markdown' || type === 'text/x-markdown' || MARKDOWN_EXT.test(file.name)) return 'markdown';
  if (type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return 'svg';
  if (IMAGE_TYPES.has(type) || (type === 'application/octet-stream' && IMAGE_EXT.test(file.name))) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || /\+(?:json|xml)$/.test(type) || TEXT_EXT.test(file.name)) return 'text';
  return 'other';
}

/** The chip's glyph: a picture for an image, a page for the rest. */
export function fileGlyph(kind: FileViewKind): 'image' | 'file' {
  return kind === 'image' || kind === 'svg' ? 'image' : 'file';
}

/** Characters of text the panel draws (a file may be 10 MB; one <pre> of
 *  that would stall the page). Past it the panel says so and offers Save a
 *  copy for the whole file. */
export const FILE_TEXT_SHOWN_MAX = 512 * 1024;

/** Characters of markdown the panel draws formatted (every inline mark is
 *  an element); a longer document reads as text. */
export const FILE_MARKDOWN_SHOWN_MAX = 128 * 1024;

/** Text the panel draws: at most FILE_TEXT_SHOWN_MAX characters, and, when
 *  cut, how many bytes of the file that is (the file's size is in bytes). */
export function shownText(text: string): { text: string; cut: boolean; shownBytes?: number } {
  if (text.length <= FILE_TEXT_SHOWN_MAX) return { text, cut: false };
  const shown = text.slice(0, FILE_TEXT_SHOWN_MAX);
  return { text: shown, cut: true, shownBytes: new TextEncoder().encode(shown).length };
}

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

/** Whether an SVG draws too much to show as a picture (it reads as text). */
export function svgDrawsTooMuch(text: string): boolean {
  try {
    return svgUseDrawn(text) > SVG_USE_DRAWN_MAX;
  } catch {
    return true; // nested too deep to count
  }
}

/** An SVG as an <img> source, built from its text (main sends it as
 *  text); null without one. */
export function svgImageSource(read: { text?: string }): string | null {
  return read.text === undefined ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(read.text)}`;
}
