// @vitest-environment jsdom
//
// The palette's "Dictate into this pane": the same toggle as the shortcut,
// for the focused pane. The palette closes first so the pane keeps the
// keyboard (Esc cancels, the shortcut stops).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import CommandPalette from '../CommandPalette';

const { dictateIntoActivePane } = vi.hoisted(() => ({ dictateIntoActivePane: vi.fn() }));
vi.mock('../../../utils/paneDictation', () => ({ dictateIntoActivePane }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function row(label: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.overflow-y-auto > div')).find(
    (el) => el.textContent?.includes(label),
  );
}

beforeEach(() => {
  dictateIntoActivePane.mockClear();
  Element.prototype.scrollIntoView = () => {
    /* jsdom has no layout to scroll */
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    plugins: { list: async () => ({ plugins: [], failures: [] }) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ ...useStore.getInitialState(), locale: 'en', commandPaletteVisible: true }));
  act(() => root.render(createElement(CommandPalette)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState(useStore.getInitialState()));
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('CommandPalette — Dictate into this pane', () => {
  it('is listed with its shortcut and toggles pane dictation', () => {
    const item = row('Dictate into this pane');
    if (!item) throw new Error('Dictate into this pane not listed');
    expect(item.textContent).toContain('⌘');

    act(() => {
      item.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(dictateIntoActivePane).toHaveBeenCalledTimes(1);
    expect(useStore.getState().commandPaletteVisible).toBe(false);
  });
});
