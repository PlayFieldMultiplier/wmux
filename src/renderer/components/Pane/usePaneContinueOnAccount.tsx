// Pane actions menu and usage-limit chip → "Continue on <account>".
//
// Moves the pane's own Claude conversation to another registered Claude
// account: the daemon stops the pane's Claude, copies the transcript into the
// account's config dir and resumes the same session id there, in the same
// pane (src/daemon/continueOnAccount.ts). Offered only while the pane runs
// Claude Code under the daemon and at least one Claude account is registered.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useDaemonModeActive } from '../../hooks/useDaemonMode';
import { IconUsers } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';
import { agentRow } from '../../../shared/agentIdentity';
import { accountGroupOf, groupAccounts } from '../../../shared/accountGroup';

/** Key of the main-menu item that opens the account submenu. */
export const PANE_CONTINUE_ACCOUNT_KEY = 'continue-on-account';

/** Daemon refusal code → message key. Anything else reads as the generic failure. */
const REFUSAL_KEYS: Record<string, string> = {
  not_claude: 'pane.continueOnAccountNotClaude',
  unknown_session: 'pane.continueOnAccountUnknownSession',
  same_account: 'pane.continueOnAccountSameAccount',
  turn_open: 'pane.continueOnAccountTurnOpen',
  busy: 'pane.continueOnAccountInProgress',
  pending: 'pane.continueOnAccountPending',
  still_running: 'pane.continueOnAccountStillRunning',
  copy_failed: 'pane.continueOnAccountCopyFailed',
  diverged: 'pane.continueOnAccountDiverged',
  unsupported: 'pane.continueOnAccountUnsupported',
  unavailable: 'pane.continueOnAccountUnsupported',
  invalid_account: 'pane.continueOnAccountInvalidAccount',
  shell_busy: 'pane.continueOnAccountShellBusy',
};

export function usePaneContinueOnAccount(opts: {
  ptyId: string | undefined;
  /** False for a read-only mirror, whose ptyIds are not this main's panes. */
  allowed: boolean;
  /** The pane's workspace: its bound Claude account's group is the one an
   *  account outside it is marked against (the pane itself may run on a
   *  rotated account of that group). */
  workspaceId?: string;
  /** Switch the open menu to the account submenu (pane menu only). */
  openSubmenu?: () => void;
}): {
  enabled: boolean;
  reload: () => void;
  mainItems: PaneActionItem[];
  subItems: PaneActionItem[];
} {
  const { ptyId, allowed, openSubmenu, workspaceId } = opts;
  const t = useT();
  const daemon = useDaemonModeActive();
  const isClaude = useStore((s) => (ptyId ? !!agentRow(s.surfaceAgent[ptyId]?.slug)?.continueOnAccount : false));
  const [accounts, setAccounts] = useState<{ id: string; name: string; group?: string }[]>([]);
  /** The bound account's group; null when the workspace binds none. */
  const [boundGroup, setBoundGroup] = useState<string | null>(null);
  const ready = allowed && daemon && isClaude && !!ptyId && !!window.electronAPI?.accounts?.continuePane;

  // Fetched when a menu opens, not per pane mount.
  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api || !ready) return;
    void api.list().then((res) => {
      const rows = res.accounts.filter((a) => agentRow(a.vendor)?.continueOnAccount);
      setAccounts(groupAccounts(rows).flatMap((b) => b.accounts).map((a) => ({ id: a.id, name: a.name, group: a.group })));
      const bound = workspaceId ? rows.find((a) => a.id === res.bindings[workspaceId]?.claude) : undefined;
      setBoundGroup(bound ? accountGroupOf(bound) : null);
    }).catch(() => { /* menu keeps the last rows */ });
  }, [ready, workspaceId]);

  const continueOn = useCallback(async (account: { id: string; name: string }) => {
    const api = window.electronAPI?.accounts;
    if (!api || !ptyId) return;
    const { pushToast } = useStore.getState();
    try {
      const res = await api.continuePane({ ptyId, accountId: account.id });
      if (res.ok) {
        pushToast({ level: 'info', message: t('pane.continueOnAccountDone', { name: account.name }) });
        return;
      }
      pushToast({ level: res.code === 'pending' ? 'warn' : 'error', message: t(REFUSAL_KEYS[res.code] ?? 'pane.continueOnAccountFailed') });
    } catch {
      pushToast({ level: 'error', message: t('pane.continueOnAccountFailed') });
    }
  }, [ptyId, t]);

  const enabled = ready && accounts.length > 0;

  const mainItems: PaneActionItem[] = useMemo(() => (enabled && openSubmenu ? [{
    key: PANE_CONTINUE_ACCOUNT_KEY,
    label: t('pane.continueOnAccount'),
    icon: <IconUsers size={14} />,
    hasPopup: true,
    onSelect: openSubmenu,
  }] : []), [enabled, openSubmenu, t]);

  // Group sections once any account has a group: a divider between groups,
  // the group under each name, and a note on a group other than the bound one.
  const subItems: PaneActionItem[] = useMemo(() => {
    const sectioned = accounts.some((a) => accountGroupOf(a) !== '');
    return accounts.map((account, i) => {
      const group = accountGroupOf(account);
      const other = boundGroup !== null && group !== boundGroup;
      return {
        key: `continue-account:${account.id}`,
        label: t('pane.continueOnAccountNamed', { name: account.name }),
        onSelect: () => { void continueOn(account); },
        ...(sectioned ? {
          detail: [group || t('accounts.noGroup'), other ? t('accounts.differentGroup') : ''].filter(Boolean).join(' · '),
          separatorBefore: i > 0 && accountGroupOf(accounts[i - 1]) !== group,
        } : {}),
      };
    });
  }, [accounts, boundGroup, continueOn, t]);

  return { enabled, reload, mainItems, subItems };
}
