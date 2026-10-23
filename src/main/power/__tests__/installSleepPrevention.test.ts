import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    handlers,
    ipcMain: {
      on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => { handlers.set(channel, handler); },
      removeAllListeners: (channel: string) => { handlers.delete(channel); },
    },
    powerMonitor: { on: () => undefined, removeListener: () => undefined },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
  };
});
vi.mock('electron', () => electron);

import { IPC } from '../../../shared/constants';
import { installSleepPrevention } from '../installSleepPrevention';

const mainFrame = {};
const webContents = { mainFrame, send: vi.fn() };
const win = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
const send = (channel: string, event: unknown, value: unknown) => electron.handlers.get(channel)!(event, value);

describe('installSleepPrevention', () => {
  beforeEach(() => electron.powerSaveBlocker.start.mockClear());

  it('takes the mode and the working flag only from the main window', () => {
    const { dispose } = installSleepPrevention(() => win);
    const other = { sender: {}, senderFrame: {} };
    const subframe = { sender: webContents, senderFrame: {} };
    send(IPC.POWER_SLEEP_MODE, other, 'always');
    send(IPC.POWER_SLEEP_MODE, subframe, 'always');
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();

    const main = { sender: webContents, senderFrame: mainFrame };
    send(IPC.POWER_SLEEP_MODE, main, 'working');
    send(IPC.POWER_AGENTS_WORKING, other, true);
    send(IPC.POWER_AGENTS_WORKING, subframe, true);
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
    send(IPC.POWER_AGENTS_WORKING, main, true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    dispose();
  });
});
