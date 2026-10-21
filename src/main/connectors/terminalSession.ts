import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { ConnectorTerminalContext } from '../../shared/connectorTerminal';
import { terminalAccessAllows } from '../../shared/connectorAccess';
import { isWslShell } from '../../shared/wsl';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { isBotWorkerSession, isBotWorkerWorkspace } from '../agents/botWorkerMergeGuard';
import { getConnectorStore } from '../factory/connectorStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { parseWriteExpectation, type WriteExpectation } from '../../daemon/writeIfUnchanged';

export async function terminalContext(getWindow: () => BrowserWindow | null): Promise<ConnectorTerminalContext> {
  const context = await sendToRenderer(getWindow, 'connectors.terminalContext', {}) as ConnectorTerminalContext;
  if (!context || !Array.isArray(context.workspaces) || !Array.isArray(context.panes)) throw new Error('Owner state unavailable');
  return context;
}

/** A session selected by the owner and subsequently resolved by main. */
export async function bindTerminalSession(
  id: string, ptyId: string,
  getWindow: () => BrowserWindow | null,
  getDaemon: () => DaemonClient | null,
): Promise<{ authorize: () => Promise<void>; ready: () => Promise<void>; write: (command: string) => Promise<boolean>; watch: (close: () => void) => () => void }> {
  const daemon = getDaemon();
  if (!daemon?.isConnected || process.platform === 'win32') throw new Error('Unsupported terminal');
  let anchor: { pid: number; workspaceId: string; paneId: string; createdAt: unknown } | undefined;
  let incarnation: string | undefined;
  let expectation: WriteExpectation | undefined;
  let submitted = false;
  let revoked = false;
  let ownershipRevision = 0;
  let pendingOwnershipChecks = 0;
  const authorize = async () => {
    if (revoked) throw new Error('Session revoked');
    if (getDaemon() !== daemon || !daemon.isConnected || isBotWorkerSession(ptyId)) throw new Error('Session unavailable');
    const rows = await daemon.rpc('daemon.listSessions', {}) as Array<{ id: string; pid: number; cmd: string; state: string; createdAt?: unknown; wslTarget?: unknown }>;
    const session = Array.isArray(rows) ? rows.find((r) => r.id === ptyId) : undefined;
    if (!session || !Number.isInteger(session.pid) || session.pid <= 0 || typeof session.cmd !== 'string'
      || isWslShell(session.cmd) || session.wslTarget || !['attached', 'detached'].includes(session.state)) throw new Error('Session unavailable');
    const context = await terminalContext(getWindow);
    const owners = context.panes.filter((p) => p.ptyIds.includes(ptyId));
    if (owners.length !== 1) throw new Error('Unknown terminal owner');
    const owner = owners[0];
    const botWorker = isBotWorkerWorkspace(owner.workspaceId);
    const connector = getConnectorStore()?.get(id);
    if (!connector?.enabled || !terminalAccessAllows(connector.terminalAccess,
      { paneId: owner.id, workspaceId: owner.workspaceId, botWorker },
      { paneIds: new Set(context.panes.map((p) => p.id)), workspaceIds: new Set(context.workspaces.map((w) => w.id)) })) throw new Error('Terminal access denied');
    if (anchor && (anchor.pid !== session.pid || anchor.createdAt !== session.createdAt
      || anchor.workspaceId !== owner.workspaceId || anchor.paneId !== owner.id)) throw new Error('Session changed');
    anchor ??= { pid: session.pid, createdAt: session.createdAt, workspaceId: owner.workspaceId, paneId: owner.id };
    if (incarnation !== undefined) {
      const state = await daemon.getAgentState(ptyId);
      if (!state?.incarnationId || state.incarnationId !== incarnation) throw new Error('Agent changed');
    }
    if (getDaemon() !== daemon || !daemon.isConnected || isBotWorkerSession(ptyId)) throw new Error('Session unavailable');
  };
  await authorize();
  const ready = async () => {
    await authorize();
    const state = await daemon.getAgentState(ptyId);
    if (!state || state.agentName || !state.inputQuiet || state.hasDraft === true) throw new Error('Choose an idle shell');
    const presence = await daemon.rpc('daemon.getLaunchPresence', { id: ptyId, probeProcess: true }) as { presence?: string; reason?: string; incarnationId?: string; inputRevision?: number; outputBytes?: number };
    if (presence?.presence !== 'absent' || presence.reason !== 'idle-shell' || !presence.incarnationId) throw new Error('Choose an idle shell');
    incarnation = presence.incarnationId;
    const prompt = await daemon.rpc('daemon.readPromptEvents', { sessionId: ptyId, limit: 1 }) as {
      events?: Array<{ type: string; byteOffset: number }>; eventCount?: number; totalBytesWritten?: number;
      keyInputRevision?: number; incarnationId?: string; emptyShellPrompt?: boolean;
    };
    // Byte slack alone admits short typed commands. Use the daemon's positive
    // empty-prompt state, reset on any key, and fence key input atomically too.
    const last = prompt?.events?.at(-1);
    if (!last || last.type !== 'prompt_end' || prompt.emptyShellPrompt !== true
      || prompt.incarnationId !== incarnation || prompt.totalBytesWritten !== presence.outputBytes
      || !Number.isSafeInteger(prompt.keyInputRevision)) throw new Error('Choose an empty shell prompt');
    const parsed = parseWriteExpectation({ outputBytes: prompt.totalBytesWritten, markerCount: prompt.eventCount,
      lastPromptMarker: last, incarnationId: incarnation, keyInputRevision: prompt.keyInputRevision, requireEmptyShellPrompt: true });
    if (!parsed) throw new Error('Prompt unavailable');
    expectation = parsed;
  };
  return {
    ready,
    watch: (close) => {
      const revoke = () => { revoked = true; close(); };
      const ended = (event: { sessionId: string }) => { if (event.sessionId === ptyId) revoke(); };
      const prompted = (event: { sessionId: string; event?: { type?: string } }) => {
        if (submitted && event.sessionId === ptyId && ['command_end', 'prompt_start'].includes(event.event?.type ?? '')) revoke();
      };
      daemon.on('session:died', ended); daemon.on('session:destroyed', ended); daemon.on('disconnected', revoke);
      daemon.on('session:prompt', prompted);
      const stopMirror = getWorkspaceMirror().onSnapshot(() => {
        if (!anchor) return;
        const mirror = getWorkspaceMirror();
        const pane = mirror.peekPaneForPty(ptyId)?.paneId;
        if (pane !== anchor.paneId || mirror.getPaneWorkspaces()?.get(pane) !== anchor.workspaceId) {
          // A mirror miss is only a reason to revalidate against the same fresh
          // owner-state source as requests; it is not a second deny authority.
          ownershipRevision++; pendingOwnershipChecks++;
          void authorize().catch(revoke).finally(() => { pendingOwnershipChecks--; });
        }
      });
      const timer = setInterval(() => { if (getDaemon() !== daemon || !daemon.isConnected) revoke(); }, 1000);
      timer.unref();
      return () => { clearInterval(timer); stopMirror(); daemon.off('session:died', ended); daemon.off('session:destroyed', ended); daemon.off('disconnected', revoke); daemon.off('session:prompt', prompted); };
    },
    authorize: async () => {
      const revision = ownershipRevision;
      if (revoked) throw new Error('Session revoked');
      if (pendingOwnershipChecks) throw new Error('Ownership check pending');
      await authorize();
      if (revoked || pendingOwnershipChecks || revision !== ownershipRevision) throw new Error('Ownership changed');
      if (!submitted || incarnation === undefined) throw new Error('Session not launched');
    },
    write: async (command) => {
      const expect = expectation; expectation = undefined;
      if (!expect || revoked || pendingOwnershipChecks) return false;
      const revision = ownershipRevision;
      try { await authorize(); } catch { revoked = true; return false; }
      if (revoked || pendingOwnershipChecks || revision !== ownershipRevision || getDaemon() !== daemon || !daemon.isConnected || isBotWorkerSession(ptyId)) return false;
      submitted = true;
      const result = await daemon.rpc('daemon.writeIfUnchanged', { sessionId: ptyId, data: `${command}\r`, expect }) as { written?: boolean };
      return result?.written === true;
    },
  };
}
