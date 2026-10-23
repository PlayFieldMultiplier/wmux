// @vitest-environment jsdom
//
// Another rail page covers the panes (mounted, inert). Shortcuts that act on a
// pane, its PTY or the layout must not run there, and the tmux prefix must not
// arm or survive a page switch — a key typed on Fleet must never reach a
// terminal the user cannot see.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// The plugins whose rail page the rail lists (the plugin list is not read here).
const railPages = vi.hoisted(() => ({ names: new Set(['office']) as ReadonlySet<string> }));
vi.mock('../../plugins/usePlugins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plugins/usePlugins')>()),
  listedRailPageNames: () => railPages.names,
}));

import { useKeyboard, WORKSPACES_ONLY_ACTIONS } from '../useKeyboard';
import { useStore } from '../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  act(() => {
    useStore.getState().setTerminalFontSize(14);
    useStore.getState().setPrefixMode(false);
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
  act(() => useStore.getState().setAppRoute('workspaces'));
});

describe('shortcuts on a rail page', () => {
  it('a key given to a plugin rail page opens it from any page and toggles it back', () => {
    act(() => useStore.getState().setShortcutOverride('plugin:office', 'Ctrl+Alt+P'));
    const key = { ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' };
    press(key);
    expect(useStore.getState().appRoute).toBe('plugin:office');
    press(key);
    expect(useStore.getState().appRoute).toBe('workspaces');
    act(() => useStore.getState().setAppRoute('fleet'));
    press(key);
    expect(useStore.getState().appRoute).toBe('plugin:office');
    act(() => useStore.getState().resetShortcut('plugin:office'));
  });

  it('a held plugin page key opens the page once and does not flip it back', () => {
    act(() => useStore.getState().setShortcutOverride('plugin:office', 'Ctrl+Alt+P'));
    const key = { ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' };
    press(key);
    press({ ...key, repeat: true });
    expect(useStore.getState().appRoute).toBe('plugin:office');
    press({ ...key, repeat: true });
    expect(useStore.getState().appRoute).toBe('plugin:office');
    act(() => useStore.getState().resetShortcut('plugin:office'));
  });

  it('the key of a plugin the rail no longer lists opens nothing', () => {
    railPages.names = new Set();
    try {
      act(() => useStore.getState().setShortcutOverride('plugin:office', 'Ctrl+Alt+P'));
      act(() => useStore.getState().setAppRoute('fleet'));
      press({ ctrlKey: true, altKey: true, key: 'p', code: 'KeyP' });
      expect(useStore.getState().appRoute).toBe('fleet');
    } finally {
      act(() => useStore.getState().resetShortcut('plugin:office'));
      railPages.names = new Set(['office']);
    }
  });

  it('pane and PTY shortcuts do nothing while Fleet covers the panes', () => {
    expect(WORKSPACES_ONLY_ACTIONS.has('closeSurface')).toBe(true);
    expect(WORKSPACES_ONLY_ACTIONS.has('splitHorizontal')).toBe(true);
    act(() => useStore.getState().setAppRoute('fleet'));
    press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(useStore.getState().terminalFontSize).toBe(14);
    act(() => useStore.getState().setAppRoute('workspaces'));
    press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(useStore.getState().terminalFontSize).toBe(15);
  });

  it('a shown floating pane can still be hidden from a page, but not opened there', () => {
    expect(WORKSPACES_ONLY_ACTIONS.has('floatingPane')).toBe(true);
    act(() => useStore.setState({ floatingPaneVisible: false }));
    act(() => useStore.getState().setAppRoute('fleet'));
    // Hidden: opening it is a Workspaces-page action.
    press({ ctrlKey: true, key: '`', code: 'Backquote' });
    expect(useStore.getState().floatingPaneVisible).toBe(false);
    // Shown (it floats over every page): the same key hides it.
    act(() => useStore.setState({ floatingPaneVisible: true }));
    press({ ctrlKey: true, key: '`', code: 'Backquote' });
    expect(useStore.getState().floatingPaneVisible).toBe(false);
    act(() => useStore.setState({ floatingPaneVisible: false }));
  });

  it('the prefix does not arm on a page, and a page switch ends an armed one', () => {
    act(() => useStore.getState().setAppRoute('settings'));
    press({ ctrlKey: true, key: 'b', code: 'KeyB' });
    expect(useStore.getState().prefixMode).toBe(false);

    act(() => useStore.getState().setAppRoute('workspaces'));
    press({ ctrlKey: true, key: 'b', code: 'KeyB' });
    expect(useStore.getState().prefixMode).toBe(true);
    act(() => useStore.getState().setAppRoute('fleet'));
    expect(useStore.getState().prefixMode).toBe(false);
  });
});
