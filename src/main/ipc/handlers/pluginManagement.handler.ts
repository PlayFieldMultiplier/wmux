import { ipcMain, type BrowserWindow } from 'electron';
import { PLUGIN_MANAGEMENT_IPC } from '../../../shared/pluginManagement';
import type { UiPluginManager } from '../../plugins/UiPluginManager';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';

export function registerPluginManagementHandlers(
  getWindow: () => BrowserWindow | null,
  getManager: () => UiPluginManager | null,
): () => void {
  const operations = {
    [PLUGIN_MANAGEMENT_IPC.list]: (manager: UiPluginManager) => manager.inventory(),
    [PLUGIN_MANAGEMENT_IPC.install]: (manager: UiPluginManager, id: unknown) => manager.install(id),
    [PLUGIN_MANAGEMENT_IPC.enabled]: (manager: UiPluginManager, name: unknown, enabled: unknown) => manager.setEnabled(name, enabled),
    [PLUGIN_MANAGEMENT_IPC.remove]: (manager: UiPluginManager, name: unknown) => manager.remove(name),
  };
  for (const [channel, operation] of Object.entries(operations)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapHandler(channel, async (event, ...args: unknown[]) => {
      if (!isMainWindowSender(event, getWindow())) throw new Error('Permission denied');
      const manager = getManager();
      if (!manager) throw new Error('Plugin manager unavailable');
      return operation(manager, args[0], args[1]);
    }));
  }
  return () => { for (const channel of Object.keys(operations)) ipcMain.removeHandler(channel); };
}
