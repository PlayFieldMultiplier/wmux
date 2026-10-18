// Close and keep folder (#2388): the way out of a task close that keeps
// refusing (its processes could not be verified gone, or its repository is
// gone). The task closes; its folder stays on disk as it is, and the toast
// names where.

import { useStore } from '../../stores';
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

/** The toast action offering Close and keep folder after a refused close;
 *  `onClosed` runs once the task closed. */
export function keepFolderAction(taskId: string, verifiedWorkspaceId: string, t: Translate, onClosed?: () => void): { label: string; onClick: () => void } {
  return {
    label: t('worktask.keepFolder.action'),
    onClick: () => {
      void closeKeepingFolder(taskId, verifiedWorkspaceId, t).then((closed) => {
        if (closed) onClosed?.();
      });
    },
  };
}
