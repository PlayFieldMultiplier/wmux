import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  BROWSER_PRIVATE_NETWORK_IPC,
  type AllowPrivateNetworkSetResult,
  type AllowPrivateNetworkState,
} from '../../../shared/browserBackend';
import { privateNetworkEnvAllowed } from '../../../shared/types';
import type { BrowserBackendStore } from '../../browser-session/BrowserBackendStore';
import { wrapHandler } from '../wrapHandler';
import { isTrustedMainFrameSender } from './browserPolicy.handler';

type GetWindow = Parameters<typeof isTrustedMainFrameSender>[1];

/**
 * Settings → Browser → Allow private network addresses. Main owns it because
 * main's navigation check and the MCP server's preflight (which asks main over
 * browser.navigationPolicy.get) both read it per navigation.
 *
 * The set answers the value in force AND whether it was saved: an opt-out the
 * file did not take still applies now but comes back after a restart, and the
 * row must not confirm it as if it would last.
 */
export function registerBrowserPrivateNetworkIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: {
    getWindow: GetWindow;
    store: Pick<BrowserBackendStore, 'allowPrivateNetwork' | 'setAllowPrivateNetwork'>;
  },
): void {
  // envForced is main's environment variable, read per call and kept apart
  // from the stored setting: it is never written to the file.
  ipcMain.handle(BROWSER_PRIVATE_NETWORK_IPC.get, wrapHandler(BROWSER_PRIVATE_NETWORK_IPC.get, (event: IpcMainInvokeEvent): AllowPrivateNetworkState =>
    isTrustedMainFrameSender(event, deps.getWindow)
      ? { allow: deps.store.allowPrivateNetwork(), envForced: privateNetworkEnvAllowed() }
      : { allow: false, envForced: false }));
  ipcMain.handle(
    BROWSER_PRIVATE_NETWORK_IPC.set,
    wrapHandler(BROWSER_PRIVATE_NETWORK_IPC.set, (event: IpcMainInvokeEvent, value: unknown): AllowPrivateNetworkSetResult => {
      // Nothing was written for a refused sender or a non-boolean value.
      if (!isTrustedMainFrameSender(event, deps.getWindow) || typeof value !== 'boolean') {
        return { allow: deps.store.allowPrivateNetwork(), saved: false };
      }
      const saved = deps.store.setAllowPrivateNetwork(value);
      return { allow: deps.store.allowPrivateNetwork(), saved };
    }),
  );
}
