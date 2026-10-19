// @vitest-environment jsdom
//
// A bot card's file chips and the side panel that shows one: each kind of
// file gets its view from what main sends (ROOM_FILE_READ), Save a copy asks
// main (ROOM_FILE_SAVE), and Escape or Close closes the panel.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { RoomFile, RoomFileReadResult, RoomFileSaveResult } from '../../../../shared/roomFiles';
import type { RoomsApi } from '../../../hooks/useRoomSync';
import { useStore } from '../../../stores';

import BotsFilePanel, { CardFiles, type OpenRoomFile } from '../BotsFiles';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);
const file = (name: string, mediaType: string, bytes = 12, id = 'f'.repeat(32)): RoomFile => ({ id, name, mediaType, bytes });

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  cleanups.push(() => { act(() => root.unmount()); el.remove(); });
  return { el, root };
}

function api(read: RoomFileReadResult | Promise<RoomFileReadResult>, save: RoomFileSaveResult = { ok: true, savedTo: '/Users/me/report.md' }) {
  return {
    fileRead: vi.fn(async () => read),
    fileSave: vi.fn(async () => save),
  } as unknown as RoomsApi & { fileRead: ReturnType<typeof vi.fn>; fileSave: ReturnType<typeof vi.fn> };
}

async function panel(f: RoomFile, read: Omit<Extract<RoomFileReadResult, { ok: true }>, 'ok' | 'file'> | Extract<RoomFileReadResult, { ok: false }>, onClose = vi.fn()) {
  const a = api('error' in read ? read : { ok: true, file: f, ...read });
  const open: OpenRoomFile = { workspaceId: 'w1', file: f };
  const m = mount(<BotsFilePanel open={open} api={a} t={t} onClose={onClose} />);
  await act(async () => { await Promise.resolve(); });
  return { ...m, a, onClose, view: () => m.el.querySelector('[data-bots-file-view]')?.getAttribute('data-bots-file-view') ?? null };
}

describe('CardFiles', () => {
  it('a chip per file — the name and the size, labelled — and nothing for a card without files', () => {
    const onOpen = vi.fn();
    const files = [file('report.md', 'text/markdown', 2048, 'a'.repeat(32)), file('shot.png', 'image/png', 10, 'b'.repeat(32))];
    const { el } = mount(<CardFiles card={{ workspaceId: 'w1', files }} t={t} shownId={'b'.repeat(32)} onOpen={onOpen} />);
    const chips = [...el.querySelectorAll<HTMLButtonElement>('[data-bots-file]')];
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['botsPage.file.open(report.md,2.0 KB)', 'botsPage.file.open(shot.png,10 B)']);
    expect(chips[0].querySelector('.wmux-bots-file-name')?.textContent).toBe('report.md');
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    act(() => chips[0].click());
    expect(onOpen).toHaveBeenCalledWith({ workspaceId: 'w1', file: files[0], opener: chips[0] });

    const none = mount(<CardFiles card={{ workspaceId: 'w1' }} t={t} onOpen={onOpen} />);
    expect(none.el.innerHTML).toBe('');
    const empty = mount(<CardFiles card={{ workspaceId: 'w1', files: [] }} t={t} onOpen={onOpen} />);
    expect(empty.el.innerHTML).toBe('');
  });
});

describe('BotsFilePanel', () => {
  it('reads the file by its room and id, loading until main answers', async () => {
    let answer!: (r: RoomFileReadResult) => void;
    const f = file('notes.txt', 'text/plain');
    const a = api(new Promise<RoomFileReadResult>((r) => { answer = r; }));
    const { el } = mount(<BotsFilePanel open={{ workspaceId: 'w1', file: f }} api={a} t={t} onClose={() => undefined} />);
    expect(a.fileRead).toHaveBeenCalledWith({ workspaceId: 'w1', fileId: f.id });
    expect(el.querySelector('[data-bots-file-state]')?.getAttribute('data-bots-file-state')).toBe('loading');
    expect(el.querySelector('[data-bots-file-panel]')?.getAttribute('aria-label')).toBe('botsPage.file.panel(notes.txt)');
    await act(async () => { answer({ ok: true, file: f, text: 'hello' }); });
    expect(el.querySelector('pre[data-bots-file-view="text"]')?.textContent).toBe('hello');
  });

  it('markdown renders as the chat does', async () => {
    const { el, view } = await panel(file('report.md', 'text/markdown'), { text: '# Title\n\nSome **bold** words' });
    expect(view()).toBe('markdown');
    expect(el.querySelector('[data-bots-file-view="markdown"] strong')?.textContent).toBe('bold');
  });

  it('markdown too heavy to draw whole (a 90,000-cell table) reads as text', async () => {
    const wide = `${'|a'.repeat(300)}|\n${'|-'.repeat(300)}|\n${'|\n'.repeat(300)}`;
    const { el, view } = await panel(file('wide.md', 'text/markdown'), { text: wide });
    expect(view()).toBe('text');
    expect(el.querySelector('[data-bots-file-note="as-text"]')).not.toBeNull();
    expect(el.querySelector('table')).toBeNull();
  });

  it('markdown past the formatted size reads as text', async () => {
    const { el, view } = await panel(file('long.md', 'text/markdown'), { text: '`a` '.repeat(40_000) });
    expect(view()).toBe('text');
    expect(el.querySelector('[data-bots-file-note="as-text"]')).not.toBeNull();
    expect(el.querySelector('code')).toBeNull();
  });

  it('code, JSON and CSV show as plain monospace text', async () => {
    for (const [name, type] of [['a.json', 'application/json'], ['rows.csv', 'text/csv'], ['main.ts', 'text/plain']] as const) {
      const { el, view } = await panel(file(name, type), { text: '{"a": 1}' });
      expect(view()).toBe('text');
      expect(el.querySelector('pre')?.className).toContain('font-mono');
    }
  });

  it('text past the shown limit says it was cut', async () => {
    const { el } = await panel(file('big.log', 'text/plain', 4_000_000), { text: 'x'.repeat(600 * 1024) });
    expect(el.querySelector('[data-bots-file-note="cut"]')?.textContent).toBe('botsPage.file.cut(512 KB,3.8 MB)');
  });

  it('an image shows from its data URL; an SVG only as an image', async () => {
    const png = await panel(file('shot.png', 'image/png'), { dataUrl: 'data:image/png;base64,iVBO' });
    expect(png.el.querySelector('[data-bots-file-view="image"] img')?.getAttribute('src')).toBe('data:image/png;base64,iVBO');
    const svg = await panel(file('logo.svg', 'image/svg+xml'), { text: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    expect(svg.el.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(svg.el.querySelector('.wmux-bots-file-body svg')).toBeNull();
  });

  it('an SVG whose nested <use> would draw too much reads as text, an icon sheet still as a picture', async () => {
    // Blink also follows a %-escaped fragment and a <use> under any prefix.
    const nested = (levels: number, attr: string, ref = (l: number) => `#l${l}`, use = 'use') => {
      let s = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ñ="http://www.w3.org/2000/svg"><defs><rect id="l0" width="1" height="1"/>';
      for (let l = 1; l <= levels; l++) s += `<g id="l${l}">${`<${use} ${attr}="${ref(l - 1)}"/>`.repeat(10)}</g>`;
      return `${s}</defs><${use} ${attr}="${ref(levels)}"/></svg>`;
    };
    const variants = [nested(6, 'href'), nested(6, 'xlink:href'), nested(6, 'href', (l) => `#%6c${l}`), nested(6, 'href', undefined, 'ñ:use')];
    for (const text of variants) {
      const heavy = await panel(file('chart.svg', 'image/svg+xml'), { text });
      expect(heavy.view()).toBe('text');
      expect(heavy.el.querySelector('img')).toBeNull();
    }
    const sheet = '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="i" d="M0 0h1v1z"/></defs>'
      + Array.from({ length: 200 }, (_, k) => `<use href="#i" x="${k}"/>`).join('') + '</svg>';
    const icons = await panel(file('icons.svg', 'image/svg+xml'), { text: sheet });
    expect(icons.view()).toBe('image');
    const cycle = await panel(file('loop.svg', 'image/svg+xml'), { text: '<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><use href="#a"/></g></svg>' });
    expect(cycle.view()).toBe('image');
  });

  it('an SVG that embeds another SVG reads as text, a PNG data URL still as a picture', async () => {
    const inner = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const embeds = [
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,${inner}"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><feImage href="DATA:IMAGE/SVG+XML;base64,PHN2Zy8+"/></svg>`,
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#100;ata:image/svg+xml,%3Csvg/%3E"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(\\64 ata:x)}</style><rect/></svg>',
    ];
    for (const text of embeds) {
      const shown = await panel(file('chart.svg', 'image/svg+xml'), { text });
      expect(shown.view()).toBe('text');
    }
    const png = await panel(file('chart.svg', 'image/svg+xml'), { text: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>' });
    expect(png.view()).toBe('image');
  });

  it('an HTML page and an SVG source never become markup: the page reads as text, the SVG only as an <img>', async () => {
    const page = await panel(file('page.html', 'text/html'), { text: '<p>hi</p><a href="https://x.test/">l</a>' });
    expect(page.view()).toBe('text');
    expect(page.el.querySelector('pre')?.textContent).toBe('<p>hi</p><a href="https://x.test/">l</a>');
    expect(page.el.querySelector('iframe, .wmux-bots-file-body p:not([data-bots-file-note]), .wmux-bots-file-body a')).toBeNull();
  });

  it('a PDF and anything else neither text nor a picture get their name, size and Save a copy', async () => {
    const pdf = await panel(file('paper.pdf', 'application/pdf'), { dataUrl: 'data:application/pdf;base64,JVBERg==' });
    expect(pdf.view()).toBe('other');
    expect(pdf.el.querySelector('[data-bots-file-save]')).not.toBeNull();
  });

  it('an unknown file says to save a copy; an error says why', async () => {
    const bin = await panel(file('build.zip', 'application/zip'), { dataUrl: 'data:application/zip;base64,UEs=' });
    expect(bin.view()).toBe('other');
    expect(bin.el.querySelector('[data-bots-file-note="no-preview"]')).not.toBeNull();
    const bad = await panel(file('gone.md', 'text/markdown'), { ok: false, error: 'not found' });
    expect(bad.el.querySelector('[data-bots-file-note="error"]')?.textContent).toBe('botsPage.file.error(not found)');
  });

  it('Save a copy asks main and says where it went; a cancel says nothing', async () => {
    const toasts: unknown[] = [];
    const pushToast = vi.fn((x: unknown) => { toasts.push(x); });
    act(() => useStore.setState({ pushToast } as never));
    const f = file('report.md', 'text/markdown');
    const { el, a } = await panel(f, { text: 'x' });
    await act(async () => { el.querySelector<HTMLButtonElement>('[data-bots-file-save]')!.click(); });
    expect(a.fileSave).toHaveBeenCalledWith({ workspaceId: 'w1', fileId: f.id });
    expect(toasts.at(-1)).toEqual({ message: 'botsPage.file.saved(/Users/me/report.md)', level: 'info' });

    const canceled = api({ ok: true, file: f, text: 'x' }, { ok: false, canceled: true });
    const m = mount(<BotsFilePanel open={{ workspaceId: 'w1', file: f }} api={canceled} t={t} onClose={() => undefined} />);
    await act(async () => { m.el.querySelector<HTMLButtonElement>('[data-bots-file-save]')!.click(); });
    expect(toasts).toHaveLength(1);
  });

  it('opens with focus on Close; Escape and Close close it, focus back on the chip that opened it', async () => {
    const area = document.createElement('div');
    area.className = 'wmux-bots-chat-area';
    const opener = document.createElement('button');
    const host = document.createElement('div');
    area.append(opener, host);
    document.body.appendChild(area);
    cleanups.push(() => area.remove());
    const onClose = vi.fn();
    const f = file('a.txt', 'text/plain');
    const root = createRoot(host);
    act(() => root.render(<BotsFilePanel open={{ workspaceId: 'w1', file: f, opener }} api={api({ ok: true, file: f, text: 'x' })} t={t} onClose={onClose} />));
    cleanups.push(() => act(() => root.unmount()));
    const closeButton = host.querySelector<HTMLButtonElement>('[data-bots-file-close]')!;
    expect(document.activeElement).toBe(closeButton);
    act(() => closeButton.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);

    // An Escape someone took first (a dialog, a menu) is theirs.
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => { opener.dispatchEvent(taken); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('an Escape while the focus is elsewhere (another surface) leaves it open', () => {
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    cleanups.push(() => elsewhere.remove());
    const onClose = vi.fn();
    const f = file('a.txt', 'text/plain');
    mount(<BotsFilePanel open={{ workspaceId: 'w1', file: f }} api={api({ ok: true, file: f, text: 'x' })} t={t} onClose={onClose} />);
    elsewhere.focus();
    act(() => { elsewhere.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
  });
});
