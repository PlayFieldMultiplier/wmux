import { ipcMain, powerMonitor, powerSaveBlocker, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/constants';
import { SleepPrevention } from './sleepPrevention';

/**
 * Wire the sleep blocker to Electron and the renderer (see sleepPrevention.ts).
 * Call once, after app 'ready': powerMonitor cannot be used before it.
 */
export function installSleepPrevention(getWindow: () => BrowserWindow | null): {
  controller: SleepPrevention;
  dispose: () => void;
} {
  const controller = new SleepPrevention({
    blocker: powerSaveBlocker,
    power: powerMonitor,
    log: (line) => console.log(line),
    onSlept: (window) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(IPC.POWER_SLEPT, window);
    },
  });
  ipcMain.removeAllListeners(IPC.POWER_SLEEP_MODE);
  ipcMain.removeAllListeners(IPC.POWER_AGENTS_WORKING);
  ipcMain.on(IPC.POWER_SLEEP_MODE, (_event, mode: unknown) => controller.setMode(mode));
  ipcMain.on(IPC.POWER_AGENTS_WORKING, (_event, working: unknown) => controller.setAgentsWorking(working === true));
  return {
    controller,
    dispose: () => {
      ipcMain.removeAllListeners(IPC.POWER_SLEEP_MODE);
      ipcMain.removeAllListeners(IPC.POWER_AGENTS_WORKING);
      controller.dispose();
    },
  };
}
