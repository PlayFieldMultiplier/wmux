import { looksLikeFolderTrustDialog } from './approvals/approvalKeystrokes';
import { renderPaneScreen, type RenderablePane } from './AwaitingScreenVerifier';
import { generateTextSnapshotUnqueued, runSmallSnapshotJob } from './HeadlessSnapshot';
import type { DaemonPipeServer } from './DaemonPipeServer';
import type { DaemonSessionState } from './types';

/**
 * Whether a session's own output shows an agent's folder-trust dialog:
 *   - 'trust': the dialog is the live screen;
 *   - 'clear': it is not, or nothing runs in the session;
 *   - 'unknown': the screen could not be read in time or whole.
 */
export type FolderTrustState = 'trust' | 'clear' | 'unknown';

/** How long the verdict waits for the screen parse. */
export const FOLDER_TRUST_READ_TIMEOUT_MS = 250;

/** What the verdict needs of a session (a ManagedSession). */
export type FolderTrustSession = RenderablePane & {
  meta: { state: DaemonSessionState };
  /** Recovered and not yet activated: its output is muted. */
  deferred: boolean;
};

type Snapshot = Parameters<typeof renderPaneScreen>[1];

export interface FolderTrustDeps {
  getSession: (id: string) => FolderTrustSession | undefined;
  /** A recovery placeholder the daemon has not started (no process yet). */
  getPendingRecovery: (id: string) => unknown;
  timeoutMs?: number;
  /** Injected in tests; defaults to a parse outside the shared snapshot queue. */
  snapshot?: Snapshot;
}

/**
 * The verdict for one session, read from the daemon's ring rather than a
 * renderer's screen, so it holds for a pane that is hidden, parked or not
 * attached yet. A session with no process ('suspended', 'dead', or a
 * recovery placeholder) shows no live dialog. A muted one holds its newest
 * output outside the ring, so the ring cannot rule a dialog out.
 *
 * The screen is rebuilt like the awaiting verifier's (renderPaneScreen): each
 * stretch of the ring at the size it was written at, a resize during the read
 * rejected, and cells the ring no longer covers marked. The parse runs beside
 * the shared snapshot queue, not behind it, and is dropped once the budget is
 * spent.
 */
export async function folderTrustState(deps: FolderTrustDeps, id: string): Promise<FolderTrustState> {
  const session = deps.getSession(id);
  if (!session) return deps.getPendingRecovery(id) !== undefined ? 'clear' : 'unknown';
  if (session.meta.state === 'suspended' || session.meta.state === 'dead') return 'clear';
  if (session.deferred || session.bridge.isMuted) return 'unknown';
  const timeoutMs = deps.timeoutMs ?? FOLDER_TRUST_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let dropped = false;
  const parse: Snapshot = deps.snapshot ?? ((req) => runSmallSnapshotJob(() =>
    generateTextSnapshotUnqueued({ ...req, budgetMs: Math.max(1, deadline - Date.now()) })));
  // Past the deadline no further parse starts, and the one under way stops at its budget.
  let wrapped: boolean[] | null = null;
  const snapshot: Snapshot = async (req) => {
    if (dropped) return { ok: false };
    const outcome = await parse(req);
    wrapped = outcome.ok ? outcome.rows.map((row) => (row as { wrapped?: boolean }).wrapped === true) : null;
    return outcome;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      dropped = true;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const frame = await Promise.race([renderPaneScreen(() => deps.getSession(id), snapshot).catch(() => null), timedOut]);
    if (!frame) return 'unknown';
    if (looksLikeFolderTrustDialog(unwrapRows(frame.rows, wrapped, frame.cols).slice(-60))) return 'trust';
    // Cells the ring no longer covers could be the dialog's.
    return frame.unknown ? 'unknown' : 'clear';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The grid's rows with each soft-wrapped continuation joined back onto the
 * row it continues. A dialog drawn wider than the pane is now reflows its
 * lines mid-word ("…one yo" / "u trust?"), and the detector reads whole
 * lines. A wrapped row filled the width, so it is padded back to it first.
 */
function unwrapRows(rows: readonly string[], wrapped: readonly boolean[] | null, cols = 0): string[] {
  if (!wrapped || wrapped.length !== rows.length) return [...rows];
  const lines: string[] = [];
  rows.forEach((row, i) => {
    if (wrapped[i] && lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].padEnd(cols) + row;
    else lines.push(row);
  });
  return lines;
}

/** What `daemon.folderTrustState` reads of the session manager. */
export interface FolderTrustSessions {
  getSession(id: string): FolderTrustSession | undefined;
  getPendingRecovery(id: string): unknown;
}

/**
 * `daemon.folderTrustState({ id })` → `{ state }`. Main asks when the renderer
 * has no screen for a pane (hidden, parked, not attached yet).
 */
export function registerFolderTrustRpc(pipeServer: Pick<DaemonPipeServer, 'onRpc'>, sessions: FolderTrustSessions): void {
  pipeServer.onRpc('daemon.folderTrustState', async (params) => {
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    return {
      state: await folderTrustState({
        getSession: (sid) => sessions.getSession(sid),
        getPendingRecovery: (sid) => sessions.getPendingRecovery(sid),
      }, id),
    };
  });
}
