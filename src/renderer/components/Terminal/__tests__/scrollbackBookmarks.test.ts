// Scrollback bookmarks (Ctrl+M) stay on the line they were set on. They used
// to be stored as baseY + viewportY, which counts baseY twice (viewportY is
// already absolute), so k lines of output while scrolled up moved the dot k
// rows onto other text. Driven through a headless xterm, which has the same
// marker API as the browser one.
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../../../stores/slices/uiSlice';
import { addAt, rowsInView } from '../scrollbackBookmarks';

function createTestStore() {
  return create<UISlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
    })),
  );
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function lines(from: number, count: number): string {
  let out = '';
  for (let i = from; i < from + count; i++) out += `line-${i}\r\n`;
  return out;
}

function textAt(term: Terminal, line: number): string {
  return term.buffer.active.getLine(line)?.translateToString(true) ?? '';
}

describe('scrollback bookmarks', () => {
  it('stays on its line and its row while output streams in below', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 100));
    term.scrollLines(-30);
    const viewportY = term.buffer.active.viewportY;
    const text = textAt(term, viewportY);
    expect(text).toMatch(/^line-\d+$/);

    expect(addAt(term, 'pty-a', store)).toBe(true);
    const ids = store.getState().terminalBookmarks['pty-a'];
    expect(ids).toHaveLength(1);
    expect(rowsInView(term, 'pty-a', ids)).toEqual([{ id: ids[0], row: 0 }]);

    await write(term, lines(100, 200));

    expect(term.buffer.active.viewportY).toBe(viewportY);
    expect(rowsInView(term, 'pty-a', ids)).toEqual([{ id: ids[0], row: 0 }]);
    const marker = term.markers.find((m) => m.id === ids[0]);
    expect(marker && textAt(term, marker.line)).toBe(text);
    term.dispose();
  });

  it('is dropped, id and all, when its line leaves a full scrollback', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 50, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    expect(addAt(term, 'pty-b', store)).toBe(true);
    const ids = store.getState().terminalBookmarks['pty-b'];
    expect(ids).toHaveLength(1);

    await write(term, lines(30, 300));

    expect(term.markers.some((m) => m.id === ids[0])).toBe(false);
    expect(store.getState().terminalBookmarks['pty-b']).toBeUndefined();
    expect(rowsInView(term, 'pty-b', ids)).toEqual([]);
    term.dispose();
  });

  it('adds nothing on the alternate screen', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    await write(term, '\x1b[?1049h');
    expect(term.buffer.active.type).toBe('alternate');

    expect(addAt(term, 'pty-c', store)).toBe(false);
    expect(store.getState().terminalBookmarks['pty-c']).toBeUndefined();
    expect(term.markers).toHaveLength(0);
    term.dispose();
  });

  it('leaves the store when its terminal is disposed', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    expect(addAt(term, 'pty-d', store)).toBe(true);
    expect(store.getState().terminalBookmarks['pty-d']).toHaveLength(1);

    term.dispose();

    expect(store.getState().terminalBookmarks['pty-d']).toBeUndefined();
  });
});
