// Close and keep folder (#2388): the owner's way out of a task close that
// keeps refusing (its processes could not be verified gone, or its folder
// cannot be removed). The task closes; its folder stays on disk as it is, and
// the toast names where. A close whose repository is gone keeps the folder on
// its own and names it the same way.

import { useStore } from '../../stores';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import type { useT } from '../../hooks/useT';

type Translate = ReturnType<typeof useT>;

/** The line saying where a closed task's folder was kept, or null when the
 *  close kept none. */
export function keptFolderMessage(res: { keptFolder?: string }, t: Translate): string | null {
  return res.keptFolder ? t('worktask.keepFolder.done', { path: res.keptFolder }) : null;
}

/** Close the task keeping its folder; true when it closed. Toasts the result. */
export async function closeKeepingFolder(taskId: string, verifiedWorkspaceId: string, t: Translate): Promise<boolean> {
  const push = useStore.getState().pushToast;
  try {
    const res = await window.electronAPI.workTask.close(taskId, verifiedWorkspaceId, { keepFolder: true });
    if (res.ok) {
      push({ level: 'info', message: keptFolderMessage(res, t) ?? t('worktask.cleanup.closed') });
      void useStore.getState().refreshMissions(verifiedWorkspaceId);
      return true;
    }
    push({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: res.error ?? '' }) });
  } catch (err) {
    push({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: err instanceof Error ? err.message : String(err) }) });
  }
  return false;
}

/** Whether a pane of `workspaceId` has its shell running a command (OSC
 *  133): work that a close of the workspace would end. */
export function workspaceRunsCommand(workspaceId: string): boolean {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  return !!ws && getWorkspacePtyIds(ws).some((ptyId) => st.commandRunningByPtyId[ptyId] === true);
}

/** The toast action offering Close and keep folder after a refused close;
 *  `onClosed` runs once the task closed. `recheck`, asked at the click: why
 *  the task may not be closed any more (its work started again since the
 *  refusal), or null; the action then toasts that and closes nothing. */
export function keepFolderAction(
  taskId: string,
  verifiedWorkspaceId: string,
  t: Translate,
  onClosed?: () => void,
  recheck?: () => string | null,
): { label: string; onClick: () => void } {
  return {
    label: t('worktask.keepFolder.action'),
    onClick: () => {
      const refused = recheck?.() ?? null;
      if (refused) {
        useStore.getState().pushToast({ level: 'warn', message: refused });
        return;
      }
      void closeKeepingFolder(taskId, verifiedWorkspaceId, t).then((closed) => {
        if (closed) onClosed?.();
      });
    },
  };
}
