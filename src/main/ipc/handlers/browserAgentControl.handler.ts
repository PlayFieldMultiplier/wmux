import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  BROWSER_AGENT_CONTROL_IPC,
  isBrowserAgentControlIntent,
  type BrowserAgentControlState,
  type LentLiveTab,
} from '../../../shared/browserAgentControl';
import type { BrowserAgentControl } from '../../browser-session/BrowserAgentControl';
import { isTrustedMainFrameSender, UNTRUSTED_SENDER_ERROR } from './browserPolicy.handler';
import { wrapHandler } from '../wrapHandler';

export interface BrowserAgentControlIpcDeps {
  getWindow: () => BrowserWindow | null;
  control: Pick<BrowserAgentControl, 'list' | 'apply'>;
  /** Live Chrome tabs lent to a workspace, and handing one back. */
  live: {
    list: (workspaceId: string) => Promise<LentLiveTab[]>;
    returnTab: (workspaceId: string, surfaceId: string) => boolean;
  };
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * The browser pane's agent controls (Stop / Resume / Take over / Hand back) and
 * the Live Chrome Return to me control. The user's side of the state only: the
 * handlers answer the main window's top frame alone, and no RPC an agent can
 * reach calls `apply`, so an agent can never lift a pause or a take-over.
 */
export function registerBrowserAgentControlIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: BrowserAgentControlIpcDeps,
): void {
  const trusted = (event: IpcMainInvokeEvent) => isTrustedMainFrameSender(event, deps.getWindow);

  ipcMain.handle(
    BROWSER_AGENT_CONTROL_IPC.list,
    wrapHandler(BROWSER_AGENT_CONTROL_IPC.list, (event: IpcMainInvokeEvent): BrowserAgentControlState[] =>
      trusted(event) ? deps.control.list() : []),
  );

  ipcMain.handle(
    BROWSER_AGENT_CONTROL_IPC.intent,
    wrapHandler(
      BROWSER_AGENT_CONTROL_IPC.intent,
      (event: IpcMainInvokeEvent, payload: unknown): Result<{ changed: boolean; state: BrowserAgentControlState }> => {
        if (!trusted(event)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        const p = (payload ?? {}) as Record<string, unknown>;
        const surfaceId = typeof p.surfaceId === 'string' ? p.surfaceId : '';
        if (!surfaceId || !isBrowserAgentControlIntent(p.intent)) return { ok: false, error: 'invalid payload' };
        return { ok: true, ...deps.control.apply(surfaceId, p.intent) };
      },
    ),
  );

  ipcMain.handle(
    BROWSER_AGENT_CONTROL_IPC.lentTabs,
    wrapHandler(
      BROWSER_AGENT_CONTROL_IPC.lentTabs,
      async (event: IpcMainInvokeEvent, payload: unknown): Promise<Result<{ tabs: LentLiveTab[] }>> => {
        if (!trusted(event)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        const workspaceId = typeof (payload as { workspaceId?: unknown } | null)?.workspaceId === 'string'
          ? (payload as { workspaceId: string }).workspaceId
          : '';
        if (!workspaceId) return { ok: false, error: 'invalid payload' };
        return { ok: true, tabs: await deps.live.list(workspaceId) };
      },
    ),
  );

  ipcMain.handle(
    BROWSER_AGENT_CONTROL_IPC.returnTab,
    wrapHandler(
      BROWSER_AGENT_CONTROL_IPC.returnTab,
      (event: IpcMainInvokeEvent, payload: unknown): Result<{ returned: boolean }> => {
        if (!trusted(event)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        const p = (payload ?? {}) as Record<string, unknown>;
        const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
        const surfaceId = typeof p.surfaceId === 'string' ? p.surfaceId : '';
        if (!workspaceId || !surfaceId) return { ok: false, error: 'invalid payload' };
        return { ok: true, returned: deps.live.returnTab(workspaceId, surfaceId) };
      },
    ),
  );
}
