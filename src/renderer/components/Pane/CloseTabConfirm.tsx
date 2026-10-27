import { useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { resolveCloseTabTarget, type CloseTabTarget } from '../../stores/closeTabConfirm';
import { useT } from '../../hooks/useT';
import { destroySurfaceRemoteSession } from '../../utils/remoteSessionTeardown';
import { resolveActivePanePtyId } from '../../hooks/useActivePaneFocus';
import { terminalRegistry } from '../../hooks/useTerminal';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

/**
 * Close a tab the way its × does: end its PTY (and a remote session this
 * desktop minted), drop the surface, and collapse the pane when it was the
 * last tab. The root pane survives closePane and is refilled with a shell.
 */
export function closeTabNow(target: CloseTabTarget): void {
  const state = useStore.getState();
  const found = resolveCloseTabTarget(state, target);
  if (!found) return;
  const { workspaceId, pane, surface } = found;
  if (surface.ptyId) window.electronAPI.pty.dispose(surface.ptyId);
  destroySurfaceRemoteSession(surface);
  const wasLastSurface = pane.surfaces.length <= 1;
  state.closeSurface(pane.id, surface.id, workspaceId);
  if (wasLastSurface) state.closePane(pane.id, workspaceId);
}

/** Hand the keyboard back to the active pane's terminal once the dialog is
 *  gone. After a click on a tab's ×, the dialog would otherwise return focus
 *  to that button (or to nothing, when the tab it sat on was closed). */
function refocusActiveTerminal(): void {
  requestAnimationFrame(() => {
    const ptyId = resolveActivePanePtyId(useStore.getState());
    if (ptyId) terminalRegistry.get(ptyId)?.focus();
  });
}

/** The one close-tab confirm, raised by the tab × and the close-tab shortcut.
 *  Cancel holds the initial focus, so Enter keeps the tab; Escape cancels too. */
export default function CloseTabConfirm() {
  const t = useT();
  const target = useStore((s) => s.closeTabConfirm);
  // What closing ends: a shell (a local PTY, or a remote session this desktop
  // minted), only a view of a remote session someone else owns, a local
  // placeholder slot (nothing runs in it), or none of these.
  const closeKind = useStore((s): 'shell' | 'remoteView' | 'placeholder' | 'other' => {
    const surface = target ? resolveCloseTabTarget(s, target)?.surface : undefined;
    if (surface?.surfaceType === 'placeholder') return 'placeholder';
    if (surface?.surfaceType === 'remote-terminal') {
      // A duplicated workspace's clone has no session id, so it views nothing.
      if (!surface.remoteSessionId) return 'other';
      return surface.remoteOwned ? 'shell' : 'remoteView';
    }
    return surface?.ptyId ? 'shell' : 'other';
  });
  const tabTitle = useStore((s) => (target ? resolveCloseTabTarget(s, target)?.surface.title : undefined));
  const dismiss = useStore((s) => s.dismissCloseTab);
  // Closed from outside (its tab went away, and the store dismissed it): the
  // keyboard goes back to the active terminal, as after Cancel, not to <body>.
  const shown = useRef(false);
  const closedHere = useRef(false);
  useEffect(() => {
    if (target) {
      shown.current = true;
      return;
    }
    if (shown.current && !closedHere.current) refocusActiveTerminal();
    shown.current = false;
    closedHere.current = false;
  }, [target]);
  if (!target) return null;
  const cancel = () => {
    closedHere.current = true;
    dismiss();
    refocusActiveTerminal();
  };
  const confirm = () => {
    closedHere.current = true;
    dismiss();
    closeTabNow(target);
    refocusActiveTerminal();
  };
  return (
    <Dialog onClose={cancel} width={360} closeOnBackdrop data-testid="close-tab-confirm">
      <DialogHeader
        title={tabTitle ? t('surface.closeTabNamed', { name: tabTitle }) : t('surface.closeTab')}
        // Closing a shell tab ends the shell and the programs attached to it;
        // programs started apart from the terminal may outlive it (#2555).
        description={closeKind === 'placeholder' ? undefined : t(closeKind === 'shell' ? 'surface.closeConfirmShell' : closeKind === 'remoteView' ? 'surface.closeConfirmRemoteView' : 'surface.closeConfirm')}
      />
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={cancel} data-close-tab-cancel>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" size="sm" onClick={confirm} data-close-tab-confirm>
          {t('surface.closeTab')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
