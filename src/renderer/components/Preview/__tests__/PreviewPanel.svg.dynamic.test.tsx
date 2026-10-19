// @vitest-environment jsdom
//
// An SVG in the file preview tab: a picture through <img>, unless it draws
// too much (nested <use>, an embedded SVG), then its source text, as the bot
// file panel shows one.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewPanel from '../PreviewPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let body = '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const preview = {
    open: vi.fn(async () => ({
      ok: true, token: 'a'.repeat(32), kind: 'image', mime: 'image/svg+xml',
      exists: true, complete: true, size: body.length, mtimeMs: 1, version: 1,
    })),
    close: vi.fn(async () => undefined),
    onChanged: vi.fn(() => () => undefined),
  };
  vi.stubGlobal('electronAPI', { preview, shell: { openPath: vi.fn() } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  vi.stubGlobal('ResizeObserver', class { observe() { /* noop */ } disconnect() { /* noop */ } });
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(svg: string) {
  body = svg;
  act(() => root.render(createElement(PreviewPanel, { filePath: '/repo/chart.svg', isActive: true, paneId: 'p1' })));
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return {
    source: container.querySelector('[data-preview-svg-source]')?.textContent ?? null,
    image: container.querySelector('[data-preview-image]'),
  };
}

describe('SVG in the file preview', () => {
  it('a nested-<use> SVG shows as its source, not a picture', async () => {
    let svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="l0" width="1" height="1"/>';
    for (let l = 1; l <= 6; l++) svg += `<g id="l${l}">${`<use href="#l${l - 1}"/>`.repeat(10)}</g>`;
    svg += '</defs><use href="#l6"/></svg>';
    const shown = await show(svg);
    expect(shown.source).toBe(svg);
    expect(shown.image).toBeNull();
  });

  it('an SVG that embeds another SVG as a data URL shows as its source', async () => {
    const inner = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,${inner}"/></svg>`;
    const shown = await show(svg);
    expect(shown.source).toBe(svg);
    expect(shown.image).toBeNull();
  });

  it('a plain SVG still shows as a picture', async () => {
    const shown = await show('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');
    expect(shown.source).toBeNull();
    expect(shown.image?.getAttribute('src')).toMatch(/^wmux-preview:\/\/a{32}\/chart\.svg\?v=1$/);
  });
});
