import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  applyAppearance,
  applyWindowsGlass,
  initialWindowsGlass,
  isWindowGlassOn,
  markWindowGlass,
  overlayColorFor,
  parseGlassRequest,
  TRANSPARENT,
  WIN_OPAQUE_BACKGROUND,
  WIN_OVERLAY_SYMBOL,
  windowsGlassSupported,
  winWindowOptions,
} from '../windowGlass';

function fakeWindow(zoom = 1) {
  const calls: string[] = [];
  const win = {
    setBackgroundMaterial: vi.fn((m: string) => { calls.push(`material:${m}`); }),
    setBackgroundColor: vi.fn((c: string) => { calls.push(`background:${c}`); }),
    setTitleBarOverlay: vi.fn((o: { color?: string }) => { calls.push(`overlay:${o.color}`); }),
    webContents: { getZoomFactor: () => zoom },
  };
  return { win, bw: win as unknown as BrowserWindow, calls };
}

describe('windowsGlassSupported', () => {
  it('reads the Windows build out of os.release()', () => {
    expect(windowsGlassSupported('win32', '10.0.26200')).toBe(true);
    expect(windowsGlassSupported('win32', '10.0.22621')).toBe(true);
    expect(windowsGlassSupported('win32', '10.0.22000')).toBe(false);
    expect(windowsGlassSupported('win32', '10.0.19045')).toBe(false);
    expect(windowsGlassSupported('win32', 'garbage')).toBe(false);
  });

  it('is false off Windows, where createWindow keeps its own path', () => {
    // macOS has vibrancy in createWindow; this check is the Windows acrylic only.
    expect(windowsGlassSupported('darwin', '25.0.0')).toBe(false);
    expect(windowsGlassSupported('linux', '6.8.0-10.0.26200')).toBe(false);
  });
});

describe('initialWindowsGlass', () => {
  it('starts with glass for Soft, Clear and an unset level on a supported build', () => {
    expect(initialWindowsGlass(true, 'soft')).toBe(true);
    expect(initialWindowsGlass(true, 'clear')).toBe(true);
    expect(initialWindowsGlass(true, null)).toBe(true);
  });

  it('starts opaque when the saved level is Off or the build has no glass', () => {
    expect(initialWindowsGlass(true, 'off')).toBe(false);
    expect(initialWindowsGlass(false, 'soft')).toBe(false);
    expect(initialWindowsGlass(false, 'clear')).toBe(false);
  });
});

describe('winWindowOptions', () => {
  it('is today\'s opaque window with glass off', () => {
    expect(winWindowOptions(false)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#121015', symbolColor: '#C2BDC9', height: 40 },
      backgroundColor: '#121015',
    });
  });

  it('is acrylic behind a transparent background and a transparent overlay with glass on', () => {
    expect(winWindowOptions(true)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#C2BDC9', height: 40 },
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic',
    });
  });

  it('never asks for Mica or a transparent window', () => {
    for (const on of [true, false]) {
      const opts = winWindowOptions(on);
      expect(opts.backgroundMaterial === undefined || opts.backgroundMaterial === 'acrylic').toBe(true);
      expect(opts.transparent).toBeUndefined();
    }
  });
});

describe('applyWindowsGlass', () => {
  it('turns glass on: material, background and overlay together', () => {
    const { win, bw, calls } = fakeWindow(1.25);
    markWindowGlass(bw, false);
    expect(applyWindowsGlass(bw, 'soft', { color: '#1a171d', symbolColor: '#aabbcc' })).toBe(true);
    expect(calls).toEqual(['material:acrylic', `background:${TRANSPARENT}`, `overlay:${TRANSPARENT}`]);
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({ color: TRANSPARENT, symbolColor: '#aabbcc', height: 50 });
    expect(isWindowGlassOn(bw)).toBe(true);
  });

  it('turns glass off back to the frame colour the renderer paints', () => {
    const { win, bw, calls } = fakeWindow();
    markWindowGlass(bw, true);
    expect(applyWindowsGlass(bw, 'off', { color: '#f4f3f1', symbolColor: '#6d6775' })).toBe(true);
    expect(calls).toEqual(['material:none', 'background:#f4f3f1', 'overlay:#f4f3f1']);
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({ color: '#f4f3f1', symbolColor: '#6d6775', height: 40 });
    expect(isWindowGlassOn(bw)).toBe(false);
  });

  it('turns glass off to the construction colours when the renderer had no colour pair', () => {
    const { win, bw } = fakeWindow();
    markWindowGlass(bw, true);
    applyWindowsGlass(bw, 'off');
    expect(win.setBackgroundColor).toHaveBeenCalledWith(WIN_OPAQUE_BACKGROUND);
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      color: WIN_OPAQUE_BACKGROUND,
      symbolColor: WIN_OVERLAY_SYMBOL,
      height: 40,
    });
  });

  it('does nothing when the level keeps the window\'s state (Soft to Clear is CSS only)', () => {
    const { win, bw } = fakeWindow();
    markWindowGlass(bw, true);
    expect(applyWindowsGlass(bw, 'clear')).toBe(false);
    expect(applyWindowsGlass(bw, 'soft')).toBe(false);
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(win.setBackgroundColor).not.toHaveBeenCalled();
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it('treats a window it never saw as opaque', () => {
    const { bw, calls } = fakeWindow();
    expect(applyWindowsGlass(bw, 'off')).toBe(false);
    expect(applyWindowsGlass(bw, 'clear')).toBe(true);
    expect(calls[0]).toBe('material:acrylic');
  });
});

describe('overlayColorFor', () => {
  it('keeps the renderer\'s colour on an opaque window and swaps in transparent under glass', () => {
    const { bw } = fakeWindow();
    markWindowGlass(bw, false);
    expect(overlayColorFor(bw, '#1a171d')).toBe('#1a171d');
    markWindowGlass(bw, true);
    expect(overlayColorFor(bw, '#1a171d')).toBe(TRANSPARENT);
  });
});

describe('parseGlassRequest', () => {
  it('accepts a known level, with the colour pair only when both are hex', () => {
    expect(parseGlassRequest({ level: 'soft', color: '#1a171d', symbolColor: '#fff' }))
      .toEqual({ level: 'soft', colors: { color: '#1a171d', symbolColor: '#fff' } });
    expect(parseGlassRequest({ level: 'off', color: '#1a171d' })).toEqual({ level: 'off' });
    expect(parseGlassRequest({ level: 'clear', color: 'red', symbolColor: '#fff' })).toEqual({ level: 'clear' });
    expect(parseGlassRequest({ level: 'off', color: '#00000000', symbolColor: '#fff' })).toEqual({ level: 'off' });
  });

  it('rejects anything else', () => {
    for (const bad of [null, undefined, 'soft', 1, {}, { level: 'mica' }, { level: true }]) {
      expect(parseGlassRequest(bad)).toBeNull();
    }
  });
});

describe('applyAppearance', () => {
  it('follows the theme on Windows when the build has glass', () => {
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    expect(applyAppearance(theme, 'light', 'win32', true)).toBe(true);
    expect(theme.themeSource).toBe('light');
    expect(applyAppearance(theme, 'light', 'win32', true)).toBe(false);
    expect(applyAppearance(theme, 'system', 'win32', true)).toBe(true);
    expect(theme.themeSource).toBe('system');
  });

  it('leaves the system appearance alone on Windows without glass and on Linux', () => {
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    expect(applyAppearance(theme, 'dark', 'win32', false)).toBe(false);
    expect(applyAppearance(theme, 'dark', 'linux', true)).toBe(false);
    expect(theme.themeSource).toBe('system');
  });

  it('keeps following the theme on macOS whatever the Windows flag', () => {
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    expect(applyAppearance(theme, 'dark', 'darwin', false)).toBe(true);
    expect(theme.themeSource).toBe('dark');
  });

  it('rejects an appearance outside dark, light and system', () => {
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    expect(applyAppearance(theme, 'auto', 'win32', true)).toBe(false);
    expect(applyAppearance(theme, undefined, 'darwin', false)).toBe(false);
    expect(theme.themeSource).toBe('system');
  });
});
