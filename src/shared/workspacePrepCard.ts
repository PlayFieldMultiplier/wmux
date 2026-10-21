/**
 * The "Preparing" card main shows for a worktree a person opened while its
 * new workspace preparation runs (main/worktask/workspacePrepCards.ts).
 * Counts and the setup's last output lines only: never a copied file's name
 * or content.
 */

export type WorkspacePrepCardStatus = 'running' | 'ready' | 'skipped' | 'failed' | 'closed';

export interface WorkspacePrepCard {
  id: string;
  /** The worktree's name (branch or task title). */
  title: string;
  /** Whether an agent starts in it once prepared (offers Start anyway). */
  startsAgent: boolean;
  status: WorkspacePrepCardStatus;
  phase?: 'copying' | 'setup';
  copied: number;
  missing: number;
  refused: number;
  /** Config files were declared but kept out (bot and fan-out workspaces). */
  copyBlocked?: boolean;
  /** status 'skipped': why nothing ran. */
  reason?: 'untrusted' | 'stale' | 'denied' | 'malformed' | 'needs-review';
  /** ms epoch the setup command started. */
  setupStartedAt?: number;
  setupTimeoutMs?: number;
  /** status 'failed'. */
  error?: string;
  outputTail?: string[];
  timedOut?: boolean;
  /** status 'failed': Discard removes the worktree and the branch this
   *  attempt made (start from an issue, Quick Launch). */
  canDiscard?: boolean;
  /** status 'failed': no answer came in time, so nothing waits to start an
   *  agent any more. Nothing was deleted; Discard or keep it. */
  expired?: boolean;
  /** A Discard refused because the worktree has changes beyond the copied
   *  files and the setup's output: the folder, to remove from the task
   *  cleanup list instead. */
  discardRefused?: string;
  /**
   * The one-time suggestion: this project copies no config files yet, and
   * its checkout has `.env` files a new worktree does not get. The card
   * offers to open New workspace setup for this folder; nothing is copied
   * until the person saves there.
   */
  suggestCopy?: { cwd: string; count: number };
  updatedAt: number;
}

/** retry / start (anyway) / discard (remove the worktree) / dismiss (keep it). */
export type WorkspacePrepDecision = 'retry' | 'start' | 'discard' | 'dismiss';

/** Cards kept after their preparation ended: a skip, a gap or the
 *  suggestion, which the person should read before dismissing it. */
export function lingers(card: WorkspacePrepCard): boolean {
  return card.status === 'skipped' || card.suggestCopy !== undefined || (card.status === 'ready' && card.missing + card.refused > 0);
}

export type PrepCardToastKey =
  | 'prepCard.toastFailed'
  | 'prepCard.toastSkipped'
  | 'prepCard.toastGaps';

/**
 * The toast for a card that changed to something the person must see, so it
 * is never missed while the sidebar is out of sight (another page, or
 * collapsed). The card stays the place to answer. Null for no toast.
 */
export function prepCardToast(
  before: WorkspacePrepCardStatus | undefined,
  card: WorkspacePrepCard,
): { key: PrepCardToastKey; values: Record<string, string | number> } | null {
  if (card.status === before) return null;
  if (card.status === 'failed') return { key: 'prepCard.toastFailed', values: { title: card.title } };
  if (card.status === 'skipped') return { key: 'prepCard.toastSkipped', values: { title: card.title } };
  if (card.status === 'ready' && card.missing + card.refused > 0) {
    return { key: 'prepCard.toastGaps', values: { title: card.title, missing: card.missing, refused: card.refused } };
  }
  return null;
}
