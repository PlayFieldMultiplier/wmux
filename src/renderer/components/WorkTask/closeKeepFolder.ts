// A task close that kept its folder (#2388): a half-removed folder whose
// repository is gone can never be checked before a deletion, so the task
// closes and the folder stays on disk as it is. The toast names where.

import type { useT } from '../../hooks/useT';

type Translate = ReturnType<typeof useT>;

/** The line saying where a closed task's folder was kept, or null when the
 *  close kept none. */
export function keptFolderMessage(res: { keptFolder?: string }, t: Translate): string | null {
  return res.keptFolder ? t('worktask.keepFolder.done', { path: res.keptFolder }) : null;
}
