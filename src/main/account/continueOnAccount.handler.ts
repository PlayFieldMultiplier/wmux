// IPC for "Continue on <account>": the renderer names a pane and a registered
// Claude account; main resolves the account to its config dir (the exact
// stored string, which the macOS keychain item is keyed on) and the daemon
// moves the pane's own conversation there (src/daemon/continueOnAccount.ts).

import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { DaemonClient } from '../DaemonClient';
import { getAccountStore, isAccessibleDir, isUnsafeKey } from './accountStore';

export type ContinuePaneResult = { ok: true } | { ok: false; code: string };

/** Stop grace (5 s) + prompt wait (5 s) + the copy, with room to spare. */
const CONTINUE_TIMEOUT_MS = 30_000;

export function registerContinueOnAccountHandler(daemonClient: DaemonClient | undefined): () => void {
  ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE);
  ipcMain.handle(IPC.ACCOUNT_CONTINUE_PANE, async (_event, args: { ptyId?: unknown; accountId?: unknown }): Promise<ContinuePaneResult> => {
    const ptyId = typeof args?.ptyId === 'string' && args.ptyId.length < 256 ? args.ptyId : '';
    const accountId = typeof args?.accountId === 'string' && !isUnsafeKey(args.accountId) ? args.accountId : '';
    if (!ptyId || !accountId) return { ok: false, code: 'invalid' };
    const account = getAccountStore().getAccount(accountId);
    if (!account || account.vendor !== 'claude') return { ok: false, code: 'invalid_account' };
    if (!isAccessibleDir(account.configDir)) return { ok: false, code: 'invalid_account' };
    // Local PTY mode has no daemon to own the stop and the relaunch.
    if (!daemonClient?.isConnected) return { ok: false, code: 'unavailable' };
    try {
      const res = await daemonClient.rpc('session.continueOnAccount', { sessionId: ptyId, configDir: account.configDir },
        { timeoutMs: CONTINUE_TIMEOUT_MS }) as { ok?: unknown; code?: unknown } | null;
      if (res?.ok === true) return { ok: true };
      return { ok: false, code: typeof res?.code === 'string' ? res.code : 'unknown' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  return () => { ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE); };
}
