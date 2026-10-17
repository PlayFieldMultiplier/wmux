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

/** Key of the main-menu item that opens the account submenu. */
export const PANE_CONTINUE_ACCOUNT_KEY = 'continue-on-account';

/** Daemon refusal code → message key. Anything else reads as the generic failure. */
const REFUSAL_KEYS: Record<string, string> = {
  not_claude: 'pane.continueOnAccountNotClaude',
  unknown_session: 'pane.continueOnAccountUnknownSession',
  same_account: 'pane.continueOnAccountSameAccount',
  turn_open: 'pane.continueOnAccountTurnOpen',
  busy: 'pane.continueOnAccountTurnOpen',
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
  /** Switch the open menu to the account submenu (pane menu only). */
  openSubmenu?: () => void;
}): {
  enabled: boolean;
  reload: () => void;
  mainItems: PaneActionItem[];
  subItems: PaneActionItem[];
} {
  const { ptyId, allowed, openSubmenu } = opts;
  const t = useT();
  const daemon = useDaemonModeActive();
  const isClaude = useStore((s) => (ptyId ? s.surfaceAgent[ptyId]?.slug === 'claude' : false));
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const ready = allowed && daemon && isClaude && !!ptyId && !!window.electronAPI?.accounts?.continuePane;

  // Fetched when a menu opens, not per pane mount.
  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api || !ready) return;
    void api.list().then((res) => {
      setAccounts(res.accounts.filter((a) => a.vendor === 'claude').map((a) => ({ id: a.id, name: a.name })));
    }).catch(() => { /* menu keeps the last rows */ });
  }, [ready]);

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
      pushToast({ level: 'error', message: t(REFUSAL_KEYS[res.code] ?? 'pane.continueOnAccountFailed') });
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

  const subItems: PaneActionItem[] = useMemo(() => accounts.map((account) => ({
    key: `continue-account:${account.id}`,
    label: t('pane.continueOnAccountNamed', { name: account.name }),
    onSelect: () => { void continueOn(account); },
  })), [accounts, continueOn, t]);

  return { enabled, reload, mainItems, subItems };
}
