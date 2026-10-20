// @vitest-environment jsdom
// @wmux-lane unit
// 'win32' here is only the stubbed electronAPI platform; the window API is a
// fake and nothing reaches the OS.
//
// The titlebar mirrors the window's fullscreen and maximized states onto
// <html data-fullscreen> / <html data-maximized>, which the sheet frame rules
// in ui.css key on: a mount-time pull, then the push from main.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import Titlebar from '../Titlebar';

vi.mock('../../StatusBar/StatusBar', () => ({ default: () => null }));

let pushMaximized: ((on: boolean) => void) | null = null;
let pushFullscreen: ((on: boolean) => void) | null = null;
const offMaximized = vi.fn();
let maximizedAtMount = false;

beforeEach(() => {
  pushMaximized = null;
  pushFullscreen = null;
  offMaximized.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: {
      isFullScreen: vi.fn(() => Promise.resolve(false)),
      onFullscreenChanged: vi.fn((cb: (on: boolean) => void) => { pushFullscreen = cb; return vi.fn(); }),
      isMaximized: vi.fn(() => Promise.resolve(maximizedAtMount)),
      onMaximizedChanged: vi.fn((cb: (on: boolean) => void) => { pushMaximized = cb; return offMaximized; }),
      setTitleBarOverlay: vi.fn(),
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  maximizedAtMount = false;
});

async function render(): Promise<() => void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Titlebar />); });
  const cleanup = () => { act(() => root.unmount()); container.remove(); };
  cleanups.push(cleanup);
  return cleanup;
}

const html = () => document.documentElement;

describe('Titlebar window-state attributes', () => {
  it('pulls the maximized state at mount', async () => {
    maximizedAtMount = true;
    await render();
    expect(html().hasAttribute('data-maximized')).toBe(true);
  });

  it('follows maximize and unmaximize pushes', async () => {
    await render();
    expect(html().hasAttribute('data-maximized')).toBe(false);
    act(() => pushMaximized?.(true));
    expect(html().hasAttribute('data-maximized')).toBe(true);
    act(() => pushMaximized?.(false));
    expect(html().hasAttribute('data-maximized')).toBe(false);
  });

  it('keeps fullscreen separate from maximized', async () => {
    await render();
    act(() => pushFullscreen?.(true));
    expect(html().hasAttribute('data-fullscreen')).toBe(true);
    expect(html().hasAttribute('data-maximized')).toBe(false);
    act(() => pushFullscreen?.(false));
    expect(html().hasAttribute('data-fullscreen')).toBe(false);
  });

  it('keeps a push that lands before the mount-time pull answers', async () => {
    let answer: ((on: boolean) => void) | undefined;
    const api = (window as unknown as { electronAPI: { window: { isMaximized: () => Promise<boolean> } } }).electronAPI.window;
    api.isMaximized = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    await render();
    act(() => pushMaximized?.(true));
    await act(async () => { answer?.(false); });
    expect(html().hasAttribute('data-maximized')).toBe(true);
  });

  it('unsubscribes and clears the attribute on unmount', async () => {
    const cleanup = await render();
    act(() => pushMaximized?.(true));
    cleanup();
    cleanups.length = 0;
    expect(offMaximized).toHaveBeenCalledTimes(1);
    expect(html().hasAttribute('data-maximized')).toBe(false);
  });
});
