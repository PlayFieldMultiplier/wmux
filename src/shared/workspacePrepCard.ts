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
  /**
   * The one-time suggestion: this project copies no config files yet, and
   * its checkout has `.env` files a new worktree does not get. The card
   * offers to open New workspace setup for this folder; nothing is copied
   * until the person saves there.
   */
  suggestCopy?: { cwd: string; count: number };
  updatedAt: number;
}

export type WorkspacePrepDecision = 'retry' | 'start' | 'dismiss';
