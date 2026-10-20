import { ipcMain, type BrowserWindow } from 'electron';
import { CONNECTOR_CATALOG_IPC, type ConnectorCatalogResult } from '../../../shared/connectorCatalog';
import { fetchConnectorCatalog } from '../../connectors/connectorCatalog';
import { isMainWindowSender } from '../mainWindowSender';

export function registerConnectorCatalogHandlers(getWindow: () => BrowserWindow | null): () => void {
  let pending = 0;
  ipcMain.removeHandler(CONNECTOR_CATALOG_IPC);
  ipcMain.handle(CONNECTOR_CATALOG_IPC, async (event, search: unknown, cursor: unknown): Promise<ConnectorCatalogResult> => {
    if (!isMainWindowSender(event, getWindow()) || pending >= 4) return { ok: false };
    pending++;
    try { return await fetchConnectorCatalog(search, cursor); }
    finally { pending--; }
  });
  return () => ipcMain.removeHandler(CONNECTOR_CATALOG_IPC);
}
