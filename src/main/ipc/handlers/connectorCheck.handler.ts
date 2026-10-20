import type { ConnectorOAuth } from '../../connectors/connectorOAuth';
import { ipcMain, type BrowserWindow } from 'electron';
import { CONNECTOR_CHECK_IPC, type ConnectorCheckResult } from '../../../shared/connectorCheck';
import { CONNECTOR_ID_RE } from '../../../shared/botConnector';
import { getConnectorStore } from '../../factory/connectorStore';
import { getSecretStore } from '../../factory/secretStore';
import { checkConnector } from '../../connectors/checkConnector';
import { isMainWindowSender } from '../mainWindowSender';

export function registerConnectorCheckHandlers(getWindow: () => BrowserWindow | null, oauth?: ConnectorOAuth): () => void {
  const active = new Map<string, AbortController>();
  ipcMain.removeHandler(CONNECTOR_CHECK_IPC);
  ipcMain.handle(CONNECTOR_CHECK_IPC, async (event, id: unknown): Promise<ConnectorCheckResult> => {
    if (!isMainWindowSender(event, getWindow()) || typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) return { status: 'unavailable' };
    if (active.has(id) || active.size >= 4) return { status: 'busy' };
    const connector = getConnectorStore()?.get(id);
    if (!connector || !connector.enabled) return { status: 'unavailable' };
    if (connector.transport !== 'http') return { status: 'unsupported' };
    const secretNames = connector.secrets.map((s) => s.secret);
    const values = secretNames.length ? getSecretStore()?.values(secretNames) : { ok: true as const, env: {} as Record<string, string> };
    if (!values?.ok) return { status: 'missing-key' };
    const headers = { ...connector.remote?.headers };
    for (const key of connector.secrets) {
      if (key.as === 'header') headers[key.header] = key.scheme === 'bearer' ? `Bearer ${values.env[key.secret]}` : values.env[key.secret];
    }
    const fingerprint = JSON.stringify(connector);
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const authRevision = oauth?.revision(id);
      const authStatus = oauth?.status(id).status;
      if (oauth && (authStatus === 'authorized' || authStatus === 'expired')) {
        const token = await oauth.accessToken(id);
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      if (controller.signal.aborted || authRevision !== oauth?.revision(id) || JSON.stringify(getConnectorStore()?.get(id)) !== fingerprint) return { status: 'changed' };
      const result = await checkConnector(connector, headers, controller.signal);
      const latestValues = secretNames.length ? getSecretStore()?.values(secretNames) : values;
      // Never let a late check validate a removed/edited configuration or a
      // rotated key. This check has no persistent effects on the library.
      if (controller.signal.aborted || authRevision !== oauth?.revision(id) || JSON.stringify(getConnectorStore()?.get(id)) !== fingerprint
        || !latestValues?.ok || JSON.stringify(latestValues.env) !== JSON.stringify(values.env)) return { status: 'changed' };
      return result;
    } catch { return { status: 'failed' }; }
    finally { active.delete(id); }
  });
  return () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
    ipcMain.removeHandler(CONNECTOR_CHECK_IPC);
  };
}
