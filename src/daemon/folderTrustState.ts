import { looksLikeFolderTrustDialog } from './approvals/approvalKeystrokes';
import type { TextSnapshotOutcome } from './HeadlessSnapshot';
import type { DaemonSessionState } from './types';

/**
 * Whether a session's own output shows an agent's folder-trust dialog:
 *   - 'trust': the dialog is the live screen;
 *   - 'clear': it is not, or nothing runs in the session;
 *   - 'unknown': the screen could not be read in time, or the session's
 *     output is not all in its ring yet.
 */
export type FolderTrustState = 'trust' | 'clear' | 'unknown';

/** How long the verdict waits for the screen parse. */
export const FOLDER_TRUST_READ_TIMEOUT_MS = 250;

/** What the verdict needs of a session (a ManagedSession). */
export interface FolderTrustSession {
  meta: { state: DaemonSessionState };
  /** Recovered and not yet activated: its output is muted. */
  deferred: boolean;
  /** Output that arrives while muted is held, not written to the ring. */
  bridge: { readonly isMuted: boolean };
}

export interface FolderTrustDeps {
  getSession: (id: string) => FolderTrustSession | undefined;
  /** A recovery placeholder the daemon has not started (no process yet). */
  isPendingRecovery: (id: string) => boolean;
  /** The visible grid parsed from the ring (queuedScreenText). */
  readScreen: (id: string) => Promise<TextSnapshotOutcome | null>;
  timeoutMs?: number;
}

/**
 * The verdict for one session, read from the daemon's ring rather than a
 * renderer's screen, so it holds for a pane that is hidden, parked or not
 * attached yet. A session with no process ('suspended', 'dead', or a
 * recovery placeholder) shows no live dialog. A muted one may hold output
 * the ring has not seen, so the ring cannot rule a dialog out.
 */
export async function folderTrustState(deps: FolderTrustDeps, id: string): Promise<FolderTrustState> {
  const session = deps.getSession(id);
  if (!session) return deps.isPendingRecovery(id) ? 'clear' : 'unknown';
  if (session.meta.state === 'suspended' || session.meta.state === 'dead') return 'clear';
  if (session.deferred || session.bridge.isMuted) return 'unknown';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? FOLDER_TRUST_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([deps.readScreen(id).catch(() => null), timedOut]);
    if (!outcome?.ok) return 'unknown';
    return looksLikeFolderTrustDialog(outcome.rows.map((row) => row.text).slice(-60)) ? 'trust' : 'clear';
  } finally {
    clearTimeout(timer);
  }
}
