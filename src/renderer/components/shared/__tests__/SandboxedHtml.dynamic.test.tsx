// @vitest-environment jsdom
//
// An untrusted HTML page drawn in a frame that can only paint: sandbox=""
// (no scripts, opaque origin), no referrer, and a CSP meta first in its head
// so nothing loads from the network. jsdom does not render srcdoc, so these
// read the frame's attributes and its document; the live smoke shows a script
// blocked and an image refused in Electron.

import { afterEach, describe, expect, it } from 'vitest';
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

describe('sandboxedHtmlDocument', () => {
  it('puts the CSP meta first in the head, ahead of anything the page could load', () => {
    const doc = sandboxedHtmlDocument('<!doctype html><html lang="ko"><head><link rel="stylesheet" href="https://x.test/a.css"></head><body><img src="https://example.com/x.png"></body></html>');
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
      const meta = firstHeadChild(sandboxedHtmlDocument(html));
      expect(meta?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
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
    act(() => root.render(<SandboxedHtmlFrame html={'<p>hi</p><script>window.parent.ran = 1</script>'} title="Preview of page.html" />));
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
