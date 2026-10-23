// @vitest-environment jsdom
//
// The "Dictate into this pane" chord runs the pane dictation toggle once per
// press (a held chord would start and stop on every repeat), only on the
// Workspaces page, and follows the user's rebinding.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard } from '../useKeyboard';
import { useStore } from '../../stores';

const { dictateIntoActivePane } = vi.hoisted(() => ({ dictateIntoActivePane: vi.fn() }));
vi.mock('../../utils/paneDictation', () => ({ dictateIntoActivePane }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}
const chord = { ctrlKey: true, shiftKey: true, key: 'S', code: 'KeyS' };

beforeEach(() => {
  dictateIntoActivePane.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'linux',
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  act(() => {
    useStore.getState().resetShortcut('dictatePane');
    useStore.getState().setAppRoute('workspaces');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => {
    useStore.getState().resetShortcut('dictatePane');
    useStore.getState().setAppRoute('workspaces');
  });
});

describe('Dictate into this pane shortcut', () => {
  it('toggles pane dictation once per press', () => {
    press(chord);
    expect(dictateIntoActivePane).toHaveBeenCalledTimes(1);
    press({ ...chord, repeat: true });
    expect(dictateIntoActivePane).toHaveBeenCalledTimes(1);
    press(chord);
    expect(dictateIntoActivePane).toHaveBeenCalledTimes(2);
  });

  it('does nothing while another page covers the panes', () => {
    act(() => useStore.getState().setAppRoute('fleet'));
    press(chord);
    expect(dictateIntoActivePane).not.toHaveBeenCalled();
  });

  it('follows a rebinding', () => {
    act(() => useStore.getState().setShortcutOverride('dictatePane', 'Ctrl+Alt+D'));
    press(chord);
    expect(dictateIntoActivePane).not.toHaveBeenCalled();
    press({ ctrlKey: true, altKey: true, key: 'd', code: 'KeyD' });
    expect(dictateIntoActivePane).toHaveBeenCalledTimes(1);
  });
});
