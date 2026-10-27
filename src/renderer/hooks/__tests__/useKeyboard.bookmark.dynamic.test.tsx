// @vitest-environment jsdom
//
// Ctrl+M bookmarks the scrollback of the active pane, but on a full-screen
// app's alternate screen it is the app's Enter: the shortcut leaves the key
// alone there, and useTerminal lets xterm send it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { Terminal } from '@xterm/xterm';
import { useKeyboard } from '../useKeyboard';
import { terminalRegistry } from '../useTerminal';
import { useStore } from '../../stores';
import { createSurface, createWorkspace, type PaneLeaf } from '../../../shared/types';
import { readSourceText } from '../../../test-utils/sourceText';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-bookmark-key';
let container: HTMLDivElement;
let root: Root;
let term: HeadlessTerminal;

function write(data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Ctrl+M on `target`; true when the shortcut took the key (preventDefault). */
function pressCtrlM(target: EventTarget = window): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'm', code: 'KeyM' });
  act(() => { target.dispatchEvent(event); });
  return event.defaultPrevented;
}

beforeEach(async () => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'linux', pty: { write: vi.fn() } };
  term = new HeadlessTerminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
  await write('one\r\ntwo\r\n');
  terminalRegistry.set(PTY, term as unknown as Terminal);
  const ws = createWorkspace('W', 1);
  const leaf = ws.rootPane as PaneLeaf;
  const surface = createSurface(PTY, 'zsh', '/');
  leaf.surfaces = [surface];
  leaf.activeSurfaceId = surface.id;
  act(() => {
    useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id, terminalBookmarks: {} });
    useStore.getState().resetShortcut('addBookmark');
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
  terminalRegistry.delete(PTY);
  term.dispose();
});

describe('Ctrl+M scrollback bookmark key', () => {
  it('bookmarks the normal screen', () => {
    expect(pressCtrlM()).toBe(true);
    expect(useStore.getState().terminalBookmarks[PTY]).toHaveLength(1);
  });

  it('leaves the key to a full-screen app on the alternate screen', async () => {
    await write('\x1b[?1049h');
    expect(pressCtrlM()).toBe(false);
    expect(useStore.getState().terminalBookmarks[PTY]).toBeUndefined();
  });

  it('is judged on the terminal the key came from, not the active pane', () => {
    // A floating pane runs a full-screen app while the active pane is a shell
    // on the normal screen: the key is the app's Enter, and the pane gets no
    // bookmark (useTerminal's handler asks the floating pane's terminal too).
    const element = document.createElement('div');
    const keyTarget = document.createElement('div');
    element.appendChild(keyTarget);
    document.body.appendChild(element);
    const floating = { element, buffer: { active: { type: 'alternate' } } };
    terminalRegistry.set('pty-floating', floating as unknown as Terminal);
    try {
      expect(pressCtrlM(keyTarget)).toBe(false);
      expect(useStore.getState().terminalBookmarks[PTY]).toBeUndefined();
    } finally {
      terminalRegistry.delete('pty-floating');
      element.remove();
    }
  });

  it('is handed to xterm by the terminal on the alternate screen', () => {
    // useTerminal's key handler answers with the same predicate, so xterm
    // encodes the key (CR) for the app instead of dropping it.
    const src = readSourceText(path.join(__dirname, '..', 'useTerminal.ts'));
    expect(src).toMatch(/if \(shortcut === 'addBookmark' && !claimsBookmarkKey\(terminal\)\) return true;/);
  });
});
