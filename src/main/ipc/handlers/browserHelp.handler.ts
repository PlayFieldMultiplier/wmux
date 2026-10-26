import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../../shared/constants';
import type { HelpRequests } from '../../browser-session/HelpRequests';
import { isTrustedMainFrameSender, UNTRUSTED_SENDER_ERROR } from './browserPolicy.handler';

export interface BrowserHelpIpcDeps {
  getWindow: () => BrowserWindow | null;
  requests: Pick<HelpRequests, 'resolveFromRenderer'>;
}

/**
 * browser_request_help — the renderer's Done / Cancel. Mirrors
 * PERMISSION_PROMPT_RESOLVE: a sender-checked, shape-validated invoke, and the
 * AUTHORITATIVE removal is the BROWSER_HELP_CLOSED push HelpRequests emits from
 * inside its own settle, so an optimistic local removal racing this is
 * harmless. A stale or already-settled id resolves `{ ok: false }` rather than
 * throwing — the row may have timed out under the operator's click.
 */
export function registerBrowserHelpIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: BrowserHelpIpcDeps): void {
  ipcMain.handle(
    IPC.BROWSER_HELP_RESOLVE,
    async (event: IpcMainInvokeEvent, payload: { requestId?: unknown; outcome?: unknown }) => {
      if (!isTrustedMainFrameSender(event, deps.getWindow)) return { ok: false, error: UNTRUSTED_SENDER_ERROR };
      if (
        !payload ||
        typeof payload.requestId !== 'string' ||
        (payload.outcome !== 'continued' && payload.outcome !== 'cancelled')
      ) {
        return { ok: false, error: 'invalid browser help payload' };
      }
      const settled = await deps.requests.resolveFromRenderer(payload.requestId, payload.outcome);
      return { ok: settled };
    },
  );
}
