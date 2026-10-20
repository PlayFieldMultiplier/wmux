import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  visible: boolean;
  destroyed: boolean;
  emit(event: string): boolean;
}

const h = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shortcuts: new Map<string, () => void>(),
  config: { enabled: true, accelerator: 'CommandOrControl+Shift+Space' },
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events');
  class BrowserWindow extends EventEmitter {
    visible = false;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: () => undefined,
      isLoading: () => false,
      send: () => undefined,
    });
    constructor() {
      super();
      h.windows.push(this);
    }
    loadFile = () => Promise.resolve();
    loadURL = () => Promise.resolve();
    setVisibleOnAllWorkspaces = () => undefined;
    setAlwaysOnTop = () => undefined;
    setBounds = () => undefined;
    setResizable = () => undefined;
    getSize = () => [680, 168];
    getPosition = () => [0, 0];
    show = () => {
      this.visible = true;
    };
    hide = () => {
      this.visible = false;
    };
    focus = () => undefined;
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      this.emit('closed');
    };
  }
  return {
    BrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    globalShortcut: {
      register: (acc: string, cb: () => void) => {
        h.shortcuts.set(acc, cb);
        return true;
      },
      unregister: (acc: string) => {
        h.shortcuts.delete(acc);
      },
    },
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
      removeHandler: (channel: string) => h.handlers.delete(channel),
    },
  };
});
vi.mock('../../window/createWindow', () => ({ normalizeDevServerUrl: () => null }));
vi.mock('../../window/auxiliaryWindows', () => ({ markAuxiliaryWindow: () => undefined }));
vi.mock('../../pipe/handlers/_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../ipc/handlers/fanout.handler', () => ({ startGuiFanOut: vi.fn() }));
vi.mock('../config', () => ({
  readQuickLaunchConfig: () => ({ ...h.config }),
  writeQuickLaunchConfig: (next: typeof h.config) => Object.assign(h.config, next),
}));

import { IPC } from '../../../shared/constants';
import type { FanOutService } from '../../worktask/FanOutService';
import { initQuickLaunch } from '../index';

const press = () => h.shortcuts.get(h.config.accelerator)?.();
const setSettings = (patch: object) => h.handlers.get(IPC.QUICK_LAUNCH_SETTINGS_SET)?.({}, patch);
const live = () => h.windows.filter((w) => !w.destroyed);
/** The page has painted: the pending show goes ahead. */
const paint = async (win: FakeWindow) => {
  win.emit('ready-to-show');
  await vi.advanceTimersByTimeAsync(0);
};

describe('quick-launch composer window is built on first use', () => {
  let ql: { dispose(): void };

  beforeEach(() => {
    // Before init, so a startup timer that would pre-build the window is caught.
    vi.useFakeTimers();
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    h.windows.length = 0;
    Object.assign(h.config, { enabled: true, accelerator: 'CommandOrControl+Shift+Space' });
    ql = initQuickLaunch({
      getMainWindow: () => null,
      fanOutService: {} as FanOutService,
      isQuitting: () => false,
      otherGlobalShortcuts: [],
    });
  });

  afterEach(() => {
    ql.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds the chord at startup but builds no window, even after the old warm-up delay', () => {
    vi.advanceTimersByTime(10_000);
    expect(h.shortcuts.has(h.config.accelerator)).toBe(true);
    expect(h.windows).toHaveLength(0);
  });

  it('builds one window on the first press and shows it once painted, then reuses it', async () => {
    press();
    expect(h.windows).toHaveLength(1);
    const [win] = h.windows;
    expect(win.visible).toBe(false);
    await paint(win);
    expect(win.visible).toBe(true);

    press();
    expect(win.visible).toBe(false);
    press();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.visible).toBe(true);
    expect(h.windows).toHaveLength(1);
  });

  it('two quick presses while the window loads build exactly one window, left open', async () => {
    press();
    press();
    expect(h.windows).toHaveLength(1);
    await paint(h.windows[0]);
    expect(h.windows[0].visible).toBe(true);
  });

  it('switching the feature off destroys the window; switching it on does not rebuild it', async () => {
    press();
    await paint(h.windows[0]);

    setSettings({ enabled: false });
    expect(live()).toHaveLength(0);

    setSettings({ enabled: true });
    expect(live()).toHaveLength(0);
    press();
    expect(live()).toHaveLength(1);
  });

  it('switching off while the window loads drops it and never shows it', async () => {
    press();
    const [win] = h.windows;
    setSettings({ enabled: false });
    await paint(win);
    expect(win.destroyed).toBe(true);
    expect(win.visible).toBe(false);
  });
});
