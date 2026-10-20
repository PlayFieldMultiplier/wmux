import path from 'node:path';
import { getWmuxDir } from '../../../daemon/config';
import { createTerminalLaunch } from '../../connectors/terminalLaunch';
import { agentRow } from '../../../shared/agentIdentity';
import { ipcMain, type BrowserWindow } from 'electron';
import { CONNECTOR_TERMINAL_IPC, type ConnectorTerminalResult } from '../../../shared/connectorTerminal';
import { CONNECTOR_ID_RE } from '../../../shared/botConnector';
import { getConnectorStore } from '../../factory/connectorStore';
import { getSecretStore } from '../../factory/secretStore';
import type { ConnectorOAuth } from '../../connectors/connectorOAuth';
import { createTerminalGateway } from '../../connectors/terminalGateway';
import { isMainWindowSender } from '../mainWindowSender';

export function registerConnectorTerminalHandlers(getWindow: () => BrowserWindow | null, oauth: ConnectorOAuth): () => void {
  const leases = new Set<() => void>();
  let pending = 0; let disposed = false;
  ipcMain.removeHandler(CONNECTOR_TERMINAL_IPC);
  ipcMain.handle(CONNECTOR_TERMINAL_IPC, async (event, id: unknown, agent: unknown): Promise<ConnectorTerminalResult> => {
    if (!isMainWindowSender(event, getWindow()) || disposed || process.platform === 'win32' || typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)
      || (typeof agent !== 'string' || !agentRow(agent)?.connectorLaunch) || leases.size + pending >= 8) return { ok: false };
    pending++;
    let launch: ReturnType<typeof createTerminalLaunch> | undefined;
    let gateway: Awaited<ReturnType<typeof createTerminalGateway>> | undefined;
    try {
      const selected = getConnectorStore()?.get(id);
      if (!selected?.enabled || selected.transport !== 'http' || (selected.tools.mode === 'listed' && !selected.tools.allowed.length)) return { ok: false };
      const fingerprint = JSON.stringify(selected);
      const headers = async () => {
        if (JSON.stringify(getConnectorStore()?.get(id)) !== fingerprint) throw new Error('Connection changed');
        const values = selected.secrets.length ? getSecretStore()?.values(selected.secrets.map((s) => s.secret)) : { ok: true as const, env: {} as Record<string, string> };
        if (!values?.ok) throw new Error('Missing key');
        const result = { ...selected.remote?.headers };
        for (const key of selected.secrets) if (key.as === 'header') result[key.header] = key.scheme === 'bearer' ? `Bearer ${values.env[key.secret]}` : values.env[key.secret];
        const status = oauth.status(id).status;
        if (status === 'authorizing' || status === 'confirm') throw new Error('Authorization pending');
        if (status === 'authorized' || status === 'expired') {
          const token = await oauth.accessToken(id);
          if (token) result.Authorization = `Bearer ${token}`;
        }
        return result;
      };
      await headers();
      gateway = await createTerminalGateway({ getConnector: () => getConnectorStore()?.get(id) ?? undefined, headers, authorizationRevision: () => oauth.revision(id) });
      if (disposed) throw new Error('Closed');
      launch = createTerminalLaunch(path.join(getWmuxDir(), 'connector-launches'), agent, id, gateway.url, gateway.token);
      const launchFile = launch;
      const lease = gateway;
      const expiry = setTimeout(() => release(), 3600_000); expiry.unref();
      const release = () => { clearTimeout(expiry); lease.close(); leases.delete(release); try { launchFile.close(); } catch { /* expired credentials no longer authorize */ } };
      leases.add(release);
      return { ok: true, command: launch.command };
    } catch { gateway?.close(); try { launch?.close(); } catch { /* closed lease */ } return { ok: false }; }
    finally { pending--; }
  });
  return () => { disposed = true; for (const close of leases) close(); ipcMain.removeHandler(CONNECTOR_TERMINAL_IPC); };
}
