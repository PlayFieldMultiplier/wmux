import path from 'node:path';
import { ipcMain, shell, type BrowserWindow } from 'electron';
import { getWmuxDir } from '../../../daemon/config';
import { CONNECTOR_OAUTH_IPC, type ConnectorOAuthResult } from '../../../shared/connectorOAuth';
import { CONNECTOR_ID_RE } from '../../../shared/botConnector';
import { ConnectorOAuth } from '../../connectors/connectorOAuth';
import { ConnectorOAuthStore } from '../../connectors/oauthStore';
import { electronSecretCrypto } from '../../factory/secretStore';
import { getConnectorStore, onConnectorLibraryChanged } from '../../factory/connectorStore';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';

export function registerConnectorOAuthHandlers(getWindow: () => BrowserWindow | null) {
  const service = new ConnectorOAuth({
    store: new ConnectorOAuthStore(path.join(getWmuxDir(), 'connector-oauth'), electronSecretCrypto()),
    getConnector: (id) => getConnectorStore()?.get(id) ?? undefined,
    openBrowser: (url) => shell.openExternal(url),
  });
  const reconcile = () => {
    const library = getConnectorStore();
    if (library && !library.writeRefusal()) service.reconcile();
  };
  const unsubscribe = onConnectorLibraryChanged(reconcile);
  reconcile();
  ipcMain.removeHandler(CONNECTOR_OAUTH_IPC);
  ipcMain.handle(CONNECTOR_OAUTH_IPC, wrapHandler(CONNECTOR_OAUTH_IPC, async (event, action: unknown, id: unknown, consentId: unknown): Promise<ConnectorOAuthResult> => {
    if (!isMainWindowSender(event, getWindow()) || typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) return { status: 'unavailable' };
    switch (action) {
      case 'approve': return typeof consentId === 'string' ? service.approve(id, consentId) : { status: 'unavailable' };
      case 'status': return service.status(id);
      case 'connect': return service.connect(id);
      case 'disconnect': return service.disconnect(id);
      case 'cancel': return service.cancel(id);
      default: return { status: 'unavailable' };
    }
  }));
  return { service, cleanup: () => { unsubscribe(); service.dispose(); ipcMain.removeHandler(CONNECTOR_OAUTH_IPC); } };
}
