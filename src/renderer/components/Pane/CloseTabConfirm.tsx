import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { findLeaf } from '../../../shared/paneUtils';
import { destroySurfaceRemoteSession } from '../../utils/remoteSessionTeardown';
import { resolveActivePanePtyId } from '../../hooks/useActivePaneFocus';
import { terminalRegistry } from '../../hooks/useTerminal';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

export interface CloseTabTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

/**
 * Close a tab the way its × does: end its PTY (and a remote session this
 * desktop minted), drop the surface, and collapse the pane when it was the
 * last tab. The root pane survives closePane and is refilled with a shell.
 */
export function closeTabNow(target: CloseTabTarget): void {
  const state = useStore.getState();
  const ws = state.workspaces.find((w) => w.id === target.workspaceId);
  const pane = ws ? findLeaf(ws.rootPane, target.paneId) : null;
  const surface = pane?.surfaces.find((s) => s.id === target.surfaceId);
  if (!pane || !surface) return;
  if (surface.ptyId) window.electronAPI.pty.dispose(surface.ptyId);
  destroySurfaceRemoteSession(surface);
  const wasLastSurface = pane.surfaces.length <= 1;
  state.closeSurface(pane.id, surface.id, target.workspaceId);
  if (wasLastSurface) state.closePane(pane.id, target.workspaceId);
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
  // minted), only a view of a remote session someone else owns, or neither.
  const closeKind = useStore((s): 'shell' | 'remoteView' | 'other' => {
    const ws = target ? s.workspaces.find((w) => w.id === target.workspaceId) : undefined;
    const pane = ws && target ? findLeaf(ws.rootPane, target.paneId) : null;
    const surface = pane?.surfaces.find((sf) => sf.id === target?.surfaceId);
    if (surface?.surfaceType === 'remote-terminal') return surface.remoteOwned ? 'shell' : 'remoteView';
    return surface?.ptyId ? 'shell' : 'other';
  });
  const tabTitle = useStore((s) => {
    const ws = target ? s.workspaces.find((w) => w.id === target.workspaceId) : undefined;
    const pane = ws && target ? findLeaf(ws.rootPane, target.paneId) : null;
    return pane?.surfaces.find((surface) => surface.id === target?.surfaceId)?.title;
  });
  const dismiss = useStore((s) => s.dismissCloseTab);
  if (!target) return null;
  const cancel = () => {
    dismiss();
    refocusActiveTerminal();
  };
  const confirm = () => {
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
        description={t(closeKind === 'shell' ? 'surface.closeConfirmShell' : closeKind === 'remoteView' ? 'surface.closeConfirmRemoteView' : 'surface.closeConfirm')}
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
