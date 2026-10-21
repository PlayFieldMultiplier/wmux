// @vitest-environment jsdom
//
// An untrusted HTML page drawn in a frame that can only paint: sandbox=""
// (no scripts, opaque origin), no referrer, and a CSP meta first in its head
// so nothing loads from the network. jsdom does not render srcdoc, so these
// read the frame's attributes and its document; the live smoke shows a script
// blocked and an image refused in Electron.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SandboxedHtmlFrame, { SANDBOXED_HTML_CSP, sandboxedHtmlDocument } from '../SandboxedHtml';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function parse(doc: string): Document {
  return new DOMParser().parseFromString(doc, 'text/html');
}

function firstHeadChild(doc: string): Element | null {
  return parse(doc).head.firstElementChild;
}

/** The srcdoc for a page that can be previewed. */
function docOf(html: string): string {
  const doc = sandboxedHtmlDocument(html);
  expect(doc).not.toBeNull();
  return doc!;
}

/** A link the frame would act on as a resource hint. */
function hints(doc: Document): string[] {
  return [...doc.querySelectorAll('link')].map((l) => l.getAttribute('rel') ?? '').filter((rel) => /preconnect|dns-prefetch|prefetch|prerender|preload/i.test(rel));
}

describe('sandboxedHtmlDocument', () => {
  it('puts the CSP meta first in the head, ahead of anything the page could load', () => {
    const doc = docOf('<!doctype html><html lang="ko"><head><link rel="stylesheet" href="https://x.test/a.css"></head><body><img src="https://example.com/x.png"></body></html>');
    const meta = firstHeadChild(doc);
    expect(meta?.tagName).toBe('META');
    expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(meta?.getAttribute('content')).toBe(SANDBOXED_HTML_CSP);
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(parse(doc).documentElement.getAttribute('lang')).toBe('ko');
    expect(parse(doc).querySelector('img')?.getAttribute('src')).toBe('https://example.com/x.png');
  });

  it('a fragment, a comment before the head or a fake head in an attribute still gets the meta first', () => {
    for (const html of ['<p>hi</p>', '<!-- <head> --><img src="https://x.test/p.gif">', '<div title="<head>"><img src=https://x.test/p.gif></div>', '']) {
      const meta = firstHeadChild(docOf(html));
      expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    }
  });

  it('drops resource hints and the page\'s own http-equiv metas, keeping its stylesheet links and other metas', () => {
    const doc = parse(docOf([
      '<head>',
      '<link rel="preconnect" href="https://a.test">',
      '<link rel="DNS-Prefetch" href="//b.test">',
      '<link rel="prefetch" href="https://c.test/x">',
      '<link rel="prerender" href="https://d.test/">',
      '<link rel=" Preload  " as="image" href="https://e.test/i.png">',
      '<link rel="modulepreload" href="https://f.test/m.js">',
      '<link rel="stylesheet preconnect" href="https://g.test/s.css">',
      '<link rel="stylesheet" href="https://h.test/s.css">',
      '<link rel="icon" href="https://i.test/f.ico">',
      '<meta http-equiv="refresh" content="0;url=https://j.test/">',
      '<meta http-equiv="Content-Security-Policy" content="img-src *">',
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width">',
      '</head><body><link rel="preconnect" href="https://k.test"><p>hi</p></body>',
    ].join('')));
    expect([...doc.querySelectorAll('link')].map((l) => l.getAttribute('href'))).toEqual(['https://h.test/s.css', 'https://i.test/f.ico']);
    const httpEquiv = [...doc.querySelectorAll('meta[http-equiv]')];
    expect(httpEquiv.map((m) => m.getAttribute('content'))).toEqual([SANDBOXED_HTML_CSP]);
    expect(doc.head.firstElementChild).toBe(httpEquiv[0]);
    expect(doc.querySelectorAll('meta[charset], meta[name="viewport"]').length).toBe(2);
    expect(doc.body.textContent).toBe('hi');
  });

  it('markup that parses differently once written back is checked again: no hint survives the frame\'s own parse', () => {
    const vectors = [
      '<form><math><mtext></form><form><mglyph><style></math><link rel=preconnect href=https://x.test>',
      '<math><mtext><table><mglyph><style><link rel=preconnect href=https://x.test></style></table></mtext></math>',
      '<svg></p><style><a id="</style><link rel=preconnect href=https://x.test>">',
      '<form><math><mtext></form><form><mglyph><style></math><meta http-equiv=refresh content="0;url=https://x.test/">',
    ];
    // The first vector is live in this parser: one strip-and-write leaves a
    // real hint behind for the frame's parse.
    const once = parse(vectors[0]);
    for (const link of once.querySelectorAll('link')) link.remove();
    expect(hints(parse(once.documentElement.outerHTML))).toEqual(['preconnect']);
    for (const html of vectors) {
      const doc = sandboxedHtmlDocument(html);
      expect(doc).not.toBeNull();
      const frame = parse(doc!);
      expect(hints(frame)).toEqual([]);
      const metas = [...frame.querySelectorAll('meta[http-equiv]')];
      expect(metas.map((m) => m.getAttribute('content'))).toEqual([SANDBOXED_HTML_CSP]);
      expect(frame.head.firstElementChild).toBe(metas[0]);
      // And it stays that way: the written page is a fixed point.
      expect(sandboxedHtmlDocument(doc!)).toBe(doc);
    }
  });

  it('a page that never settles is refused (null: shown as source only)', () => {
    const real = DOMParser.prototype.parseFromString;
    // Every parse grows a fresh hint, as markup that mutates on each round would.
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (this: DOMParser, source: string, type: DOMParserSupportedType) {
      const doc = real.call(this, source, type);
      const link = doc.createElement('link');
      link.setAttribute('rel', 'preconnect');
      link.setAttribute('href', 'https://x.test');
      doc.body.append(link);
      return doc;
    });
    try {
      expect(sandboxedHtmlDocument('<p>hi</p>')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('the policy loads nothing from the network: no default, data: images and fonts, inline styles', () => {
    expect(SANDBOXED_HTML_CSP).toContain("default-src 'none'");
    expect(SANDBOXED_HTML_CSP).toContain('img-src data:');
    expect(SANDBOXED_HTML_CSP).toContain('font-src data:');
    expect(SANDBOXED_HTML_CSP).toContain("style-src 'unsafe-inline'");
    expect(SANDBOXED_HTML_CSP).not.toMatch(/https?:|\*|'self'|script-src/);
  });
});

describe('SandboxedHtmlFrame', () => {
  it('an iframe with sandbox="" (no scripts, no same origin), no referrer and the page with its CSP as srcdoc', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => root.render(<SandboxedHtmlFrame srcDoc={docOf('<p>hi</p><script>window.parent.ran = 1</script>')} title="Preview of page.html" />));
    cleanups.push(() => { act(() => root.unmount()); el.remove(); });
    const frame = el.querySelector('iframe')!;
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('title')).toBe('Preview of page.html');
    expect(frame.hasAttribute('src')).toBe(false);
    const doc = frame.getAttribute('srcdoc')!;
    expect(firstHeadChild(doc)?.getAttribute('content')).toBe(SANDBOXED_HTML_CSP);
    // The script is the page's text inside the frame, never run in this document.
    expect(parse(doc).querySelector('script')?.textContent).toBe('window.parent.ran = 1');
    expect((window as unknown as { ran?: number }).ran).toBeUndefined();
  });
});
