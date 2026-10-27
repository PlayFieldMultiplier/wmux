import { looksLikeFolderTrustDialog } from './approvals/approvalKeystrokes';
import { AWAITING_RENDER_WINDOW_BYTES, renderPaneScreen, type RenderablePane } from './AwaitingScreenVerifier';
import { generateTextSnapshotUnqueued, runSmallSnapshotJob } from './HeadlessSnapshot';
import { UNKNOWN_CELL } from './sessionTextReplay';
import { joinWrappedRows } from './web/hostSearch';
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

/** Room above the tail window for the mode preamble and the unknown-cell fill. */
const TAIL_SLACK_BYTES = 64 * 1024;

/** Rows a dialog may take, up to the last row with content: the tallest
 *  measured one is 26 (Codex at 22 columns). */
const DIALOG_SPAN_ROWS = 30;

/** What the verdict needs of a session (a ManagedSession). */
export type FolderTrustSession = RenderablePane & {
  meta: { state: DaemonSessionState };
  bridge: { heldOutput(): { data: string; full: boolean } | null };
  /** Resized while muted: the held output was dropped, or mixes sizes. */
  resizedWhileMuted?: boolean;
};

type Snapshot = Parameters<typeof renderPaneScreen>[1];

export interface FolderTrustDeps {
  getSession: (id: string) => FolderTrustSession | undefined;
  timeoutMs?: number;
  /** Injected in tests; defaults to a parse outside the shared snapshot queue. */
  snapshot?: Snapshot;
}

/**
 * The verdict for one session, read from the daemon's ring rather than a
 * renderer's screen, so it holds for a pane that is hidden, parked or not
 * attached yet. A session with no process ('suspended', 'dead', or a
 * recovery placeholder) shows no live dialog. A muted one (recovered, not
 * shown yet) holds its newest output outside the ring, so the ring and that
 * held output are read together; once the hold overflowed (it keeps the
 * head, so the current screen is missing) or a resize dropped it, the verdict
 * is 'unknown'.
 *
 * The screen is rebuilt like the awaiting verifier's (renderPaneScreen): each
 * stretch of the ring at the size it was written at, a resize during the read
 * rejected, and cells the ring no longer covers marked; a ring larger than
 * the tail window is read from its tail. The parse runs beside the shared
 * snapshot queue, not behind it, and is dropped once the budget is spent.
 */
export async function folderTrustState(deps: FolderTrustDeps, id: string): Promise<FolderTrustState> {
  const session = deps.getSession(id);
  // No process runs under an id the daemon holds no live session for: a
  // recovery placeholder, a record kept only on disk, a closed pane.
  if (!session) return 'clear';
  if (session.meta.state === 'suspended' || session.meta.state === 'dead') return 'clear';
  let pane: RenderablePane = session;
  if (session.bridge.isMuted) {
    const held = session.bridge.heldOutput();
    if (!held || held.full || session.resizedWhileMuted) return 'unknown';
    pane = withHeldOutput(session, Buffer.from(held.data));
  }
  const timeoutMs = deps.timeoutMs ?? FOLDER_TRUST_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let dropped = false;
  const parse: Snapshot = deps.snapshot ?? ((req) => runSmallSnapshotJob(() =>
    generateTextSnapshotUnqueued({ ...req, budgetMs: Math.max(1, deadline - Date.now()) })));
  // Past the deadline no further parse starts, and the one under way stops at its budget.
  let firstRead = true;
  const snapshot: Snapshot = async (req) => {
    if (dropped) return { ok: false };
    // A whole ring larger than the tail window does not parse within the
    // budget: answer 'budget' at once, so renderPaneScreen reads its tail.
    // A live dialog is the pane's newest output, so the tail holds its draw.
    const skipWhole = firstRead && req.initial.length > AWAITING_RENDER_WINDOW_BYTES + TAIL_SLACK_BYTES;
    firstRead = false;
    if (skipWhole) return { ok: false, reason: 'budget' };
    return parse(req);
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
    const frame = await Promise.race([renderPaneScreen(() => (deps.getSession(id) === session ? pane : undefined), snapshot).catch(() => null), timedOut]);
    if (!frame) return 'unknown';
    const lines = joinWrappedRows(frame.rows.map((text, i) => ({ text, wrapped: frame.wrapped?.[i] === true })), frame.cols);
    if (looksLikeFolderTrustDialog(lines.slice(-60))) return 'trust';
    return frame.unknown && unknownWhereADialogWouldBe(frame.unknown) ? 'unknown' : 'clear';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A muted session as the parse sees it: its ring followed by the output held
 * outside it, at the size the ring last recorded (no resize while muted), and
 * no longer muted, since nothing of its output is missing.
 */
function withHeldOutput(session: FolderTrustSession, held: Buffer): RenderablePane {
  return {
    meta: session.meta,
    ptyProcess: session.ptyProcess,
    ringBuffer: {
      readAllWithGeometry: () => {
        const ring = session.ringBuffer.readAllWithGeometry();
        return { ...ring, data: Buffer.concat([ring.data, held]), writtenAt: ring.writtenAt + held.length };
      },
    },
    bridge: { isMuted: false, outputModes: session.bridge.outputModes },
  };
}

/**
 * Whether a cell the read could not see lies where a dialog would be: in the
 * DIALOG_SPAN_ROWS rows up to the last row with content. A full-screen TUI's
 * old cells above that (a header it never redraws) cannot hide one.
 */
function unknownWhereADialogWouldBe(unknownRows: readonly string[]): boolean {
  let last = unknownRows.length - 1;
  while (last >= 0 && unknownRows[last].trim() === '') last--;
  return unknownRows.slice(Math.max(0, last - DIALOG_SPAN_ROWS + 1), last + 1).some((row) => row.includes(UNKNOWN_CELL));
}

/** What `daemon.folderTrustState` reads of the session manager. */
export interface FolderTrustSessions {
  getSession(id: string): FolderTrustSession | undefined;
}

/**
 * `daemon.folderTrustState({ id })` → `{ state }`. Main asks when the renderer
 * has no screen for a pane (hidden, parked, not attached yet).
 */
export function registerFolderTrustRpc(pipeServer: Pick<DaemonPipeServer, 'onRpc'>, sessions: FolderTrustSessions): void {
  pipeServer.onRpc('daemon.folderTrustState', async (params) => {
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    return {
      state: await folderTrustState({ getSession: (sid) => sessions.getSession(sid) }, id),
    };
  });
}

/** What a writer that stood aside says, by verdict. */
export const FOLDER_TRUST_REFUSAL_REASON = {
  trust: 'pane at folder-trust prompt',
  unknown: 'pane screen unreadable, folder-trust prompt not ruled out',
} as const;

/**
 * The verdict that keeps a daemon writer from typing into `id` now, or null
 * when it may write: 'trust' always; 'unknown' only for an automated writer
 * (`refuseUnknown`), never for a person's own input. One log line per
 * refusal, naming the writer and the verdict.
 */
export async function folderTrustRefusal(
  sessions: FolderTrustSessions,
  id: string,
  writer: string,
  opts: { refuseUnknown: boolean; log: (message: string) => void },
): Promise<'trust' | 'unknown' | null> {
  const verdict = await folderTrustState({ getSession: (sid) => sessions.getSession(sid) }, id);
  if (verdict === 'clear' || (verdict === 'unknown' && !opts.refuseUnknown)) return null;
  opts.log(`[folder-trust] refused ${writer} on pane ${id}: folder-trust ${verdict}`);
  return verdict;
}

/** A key a daemon writer did not send: the pane is on a folder-trust prompt, or cannot rule one out. */
export class FolderTrustRefusedError extends Error {}
