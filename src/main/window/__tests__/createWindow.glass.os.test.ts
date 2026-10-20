import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The options createWindow hands to BrowserWindow, per platform, Windows build
// and persisted glass level. platform.ts reads process.platform when it loads,
// so each case stubs the platform and imports createWindow afresh.

const h = vi.hoisted(() => ({
  release: '10.0.26200',
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, release: () => h.release };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = {
      on: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      session: { webRequest: { onHeadersReceived: vi.fn() } },
    };
    constructor(opts: Record<string, unknown>) {
      h.options.push(opts);
    }
    on = vi.fn();
    maximize = vi.fn();
    isDestroyed = () => false;
  }
  return {
    app: { isPackaged: false },
    BrowserWindow,
    powerMonitor: { on: vi.fn() },
    screen: { getAllDisplays: () => [] },
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('../windowDisplayed', () => ({ windowDisplayedReporter: { attach: vi.fn() } }));
vi.mock('../flashFrame', () => ({ attachFlashFrameAutoClear: vi.fn() }));
vi.mock('../windowState', () => ({
  DEFAULT_WINDOW_SIZE: { width: 1280, height: 800 },
  MIN_WINDOW_SIZE: { width: 600, height: 400 },
  loadWindowState: () => null,
  planRestore: () => ({ maximized: false, fullScreen: false }),
  saveWindowState: vi.fn(),
  saveWindowStateSync: vi.fn(),
}));

const realPlatform = process.platform;

async function optionsFor(platform: NodeJS.Platform, release: string, windowGlass: unknown) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  h.release = release;
  h.options.length = 0;
  vi.resetModules();
  const { createWindow } = await import('../createWindow');
  const { isWindowGlassOn } = await import('../windowGlass');
  const win = createWindow({ deferLoad: true, windowGlass });
  return { opts: h.options[0], glassOn: isWindowGlassOn(win) };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL = 'http://127.0.0.1:5173/';
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete (globalThis as Record<string, unknown>).MAIN_WINDOW_VITE_DEV_SERVER_URL;
});

describe('createWindow window glass options', () => {
  it.each(['soft', 'clear', null])('Windows 11 26200 with level %s: acrylic behind a transparent window', async (level) => {
    const { opts, glassOn } = await optionsFor('win32', '10.0.26200', level);
    expect(opts.backgroundMaterial).toBe('acrylic');
    expect(opts.backgroundColor).toBe('#00000000');
    expect(opts.titleBarOverlay).toEqual({ color: '#00000000', symbolColor: '#C2BDC9', height: 40 });
    expect(opts.vibrancy).toBeUndefined();
    expect(glassOn).toBe(true);
  });

  it('Windows 11 with glass Off: today\'s opaque window', async () => {
    const { opts, glassOn } = await optionsFor('win32', '10.0.26200', 'off');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.backgroundColor).toBe('#121015');
    expect(opts.titleBarOverlay).toEqual({ color: '#121015', symbolColor: '#C2BDC9', height: 40 });
    expect(glassOn).toBe(false);
  });

  it.each(['10.0.19045', '10.0.22000'])('Windows build %s: opaque whatever the level', async (release) => {
    const { opts, glassOn } = await optionsFor('win32', release, 'clear');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.backgroundColor).toBe('#121015');
    expect(opts.titleBarOverlay).toEqual({ color: '#121015', symbolColor: '#C2BDC9', height: 40 });
    expect(glassOn).toBe(false);
  });

  it('macOS keeps its vibrancy material and no acrylic', async () => {
    const { opts } = await optionsFor('darwin', '25.0.0', 'soft');
    expect(opts.vibrancy).toBe('sidebar');
    expect(opts.backgroundColor).toBe('#00000000');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.titleBarOverlay).toBeUndefined();
  });

  it('Linux stays opaque', async () => {
    const { opts } = await optionsFor('linux', '6.8.0', 'soft');
    expect(opts.backgroundColor).toBe('#1A171D');
    expect(opts.backgroundMaterial).toBeUndefined();
    expect(opts.vibrancy).toBeUndefined();
  });
});
