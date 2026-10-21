import path from 'node:path';
import { getWmuxDir } from '../../../daemon/config';
import { createTerminalLaunch } from '../../connectors/terminalLaunch';
import { agentRow } from '../../../shared/agentIdentity';
import { ipcMain, type BrowserWindow } from 'electron';
import { CONNECTOR_TERMINAL_IPC, type ConnectorTerminalResult } from '../../../shared/connectorTerminal';
import { CONNECTOR_ID_RE } from '../../../shared/botConnector';
import { getConnectorStore, onConnectorLibraryChanged } from '../../factory/connectorStore';
import { getSecretStore } from '../../factory/secretStore';
import type { ConnectorOAuth } from '../../connectors/connectorOAuth';
import type { createTerminalGateway } from '../../connectors/terminalGateway';
import { isMainWindowSender } from '../mainWindowSender';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import { bindTerminalSession, terminalContext } from '../../connectors/terminalSession';

export function registerConnectorTerminalHandlers(getWindow: () => BrowserWindow | null, source: ConnectorOAuth | (() => Promise<ConnectorOAuth>), getDaemon: () => DaemonClient | null = () => null): () => void {
  const leases = new Set<() => void>();
  const closeAll = () => { for (const close of leases) close(); };
  const unsubscribeLibrary = onConnectorLibraryChanged(closeAll);
  let pending = 0; let disposed = false;
  ipcMain.removeHandler(`${CONNECTOR_TERMINAL_IPC}:targets`);
  ipcMain.handle(`${CONNECTOR_TERMINAL_IPC}:targets`, wrapHandler(`${CONNECTOR_TERMINAL_IPC}:targets`, async (event) => {
    if (!isMainWindowSender(event, getWindow()) || disposed) return null;
    try { return await terminalContext(getWindow); } catch { return null; }
  }));
  ipcMain.removeHandler(CONNECTOR_TERMINAL_IPC);
  ipcMain.handle(CONNECTOR_TERMINAL_IPC, wrapHandler(CONNECTOR_TERMINAL_IPC, async (event, id: unknown, agent: unknown, ptyId: unknown): Promise<ConnectorTerminalResult> => {
    if (!isMainWindowSender(event, getWindow()) || disposed || process.platform === 'win32' || typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)
      || typeof ptyId !== 'string' || ptyId.length > 128 || !ptyId.startsWith('daemon-')
      || (typeof agent !== 'string' || !agentRow(agent)?.connectorLaunch) || leases.size + pending >= 8) return { ok: false };
    pending++;
    let launch: ReturnType<typeof createTerminalLaunch> | undefined;
    let gateway: Awaited<ReturnType<typeof createTerminalGateway>> | undefined;
    try {
      const selected = getConnectorStore()?.get(id);
      if (!selected?.enabled || selected.transport !== 'http' || (selected.tools.mode === 'listed' && !selected.tools.allowed.length)) return { ok: false };
      const session = await bindTerminalSession(id, ptyId, getWindow, getDaemon);
      const oauth = typeof source === 'function' ? await source() : source;
      const { createTerminalGateway } = await import('../../connectors/terminalGateway');
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
      let markUsed = () => { /* installed before the agent can use the lease */ };
      gateway = await createTerminalGateway({ getConnector: () => getConnectorStore()?.get(id) ?? undefined, headers, authorizationRevision: () => oauth.revision(id), authorize: async () => { await session.authorize(); markUsed(); } });
      if (disposed) throw new Error('Closed');
      launch = createTerminalLaunch(path.join(getWmuxDir(), 'connector-launches'), agent, id, gateway.url, gateway.token);
      const launchFile = launch;
      const lease = gateway;
      let stopWatching = () => { /* watcher is installed before launch */ };
      let expiry = setTimeout(() => release(), 120_000); expiry.unref();
      let released = false;
      const release = () => { if (released) return; released = true; clearTimeout(expiry); stopWatching(); lease.close(); leases.delete(release); try { launchFile.close(); } catch { /* expired credentials no longer authorize */ } };
      leases.add(release);
      let used = false;
      markUsed = () => { if (used || released) return; used = true; clearTimeout(expiry); expiry = setTimeout(release, 3600_000); expiry.unref(); };
      stopWatching = session.watch(release);
      try {
        await session.ready();
        if (disposed || released || JSON.stringify(getConnectorStore()?.get(id)) !== fingerprint || !await session.write(launch.command)) throw new Error('Launch refused');
      } catch (error) { release(); throw error; }
      return { ok: true };
    } catch { gateway?.close(); try { launch?.close(); } catch { /* closed lease */ } return { ok: false }; }
    finally { pending--; }
  }));
  return () => { disposed = true; closeAll(); unsubscribeLibrary(); ipcMain.removeHandler(CONNECTOR_TERMINAL_IPC); ipcMain.removeHandler(`${CONNECTOR_TERMINAL_IPC}:targets`); };
}
