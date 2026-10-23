// IPC for voice dictation (shared/dictation). Only the main window's own
// frame may ask: a download spends the owner's bandwidth and disk, and the
// microphone prompt speaks for the app.

import { app, ipcMain, net, systemPreferences, type BrowserWindow } from 'electron';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { IPC } from '../../shared/constants';
import type { DictationAssetsResult, DictationMicAccess, DictationModelState } from '../../shared/dictation';
import { isMainWindowSender } from '../ipc/mainWindowSender';
import { DictationModelStore } from './modelStore';

const WASM_FILE = 'ort-wasm-simd-threaded.wasm';

/** onnxruntime-web's .wasm: an extra resource of a packaged app
 *  (forge.config.ts), node_modules in development. */
function wasmPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, WASM_FILE)
    : path.join(app.getAppPath(), 'node_modules', 'onnxruntime-web', 'dist', WASM_FILE);
}

/** The OS's answer for the microphone, asking on macOS the first time. */
export async function micAccess(platform: NodeJS.Platform = process.platform): Promise<DictationMicAccess> {
  if (platform !== 'darwin') return 'granted';
  // Chromium's fake capture device (a test clip, scripts/control-wmux.mjs
  // --fake-audio) never opens the microphone, so there is nothing to ask.
  if (app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return 'granted';
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  return 'denied';
}

export function registerDictationHandlers(getWindow: () => BrowserWindow | null): () => void {
  const push = (state: DictationModelState) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DICTATION_STATE, state);
  };
  const store = new DictationModelStore({
    dataDir: getWmuxDir(),
    // no-store: the model is kept in the data folder, so the HTTP cache would hold a second copy.
    fetch: (url, init) => net.fetch(url, { signal: init.signal, cache: 'no-store' }),
    wasmPath,
    onState: push,
  });
  const fromMain = (e: Electron.IpcMainInvokeEvent) => isMainWindowSender(e, getWindow());
  const notAllowed: DictationModelState = { state: 'failed', message: 'not allowed' };

  ipcMain.removeHandler(IPC.DICTATION_STATUS);
  ipcMain.handle(IPC.DICTATION_STATUS, (e) => (fromMain(e) ? store.status() : notAllowed));
  ipcMain.removeHandler(IPC.DICTATION_DOWNLOAD);
  ipcMain.handle(IPC.DICTATION_DOWNLOAD, (e) => (fromMain(e) ? store.download() : notAllowed));
  ipcMain.removeHandler(IPC.DICTATION_CANCEL);
  ipcMain.handle(IPC.DICTATION_CANCEL, (e) => {
    if (fromMain(e)) store.cancel();
  });
  ipcMain.removeHandler(IPC.DICTATION_ASSETS);
  ipcMain.handle(IPC.DICTATION_ASSETS, async (e): Promise<DictationAssetsResult> => {
    if (!fromMain(e)) return { ok: false, state: notAllowed };
    try {
      const assets = await store.loadAssets();
      return assets ? { ok: true, assets } : { ok: false, state: store.status() };
    } catch (err) {
      return { ok: false, state: { state: 'failed', message: err instanceof Error ? err.message : String(err) } };
    }
  });
  ipcMain.removeHandler(IPC.DICTATION_MIC_ACCESS);
  ipcMain.handle(IPC.DICTATION_MIC_ACCESS, (e) => (fromMain(e) ? micAccess() : 'denied'));

  return () => {
    store.cancel();
    for (const channel of [IPC.DICTATION_STATUS, IPC.DICTATION_DOWNLOAD, IPC.DICTATION_CANCEL, IPC.DICTATION_ASSETS, IPC.DICTATION_MIC_ACCESS]) {
      ipcMain.removeHandler(channel);
    }
  };
}
