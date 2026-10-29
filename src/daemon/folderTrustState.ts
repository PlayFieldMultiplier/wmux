import { readFolderTrustScreen } from './approvals/approvalKeystrokes';
import { AWAITING_RENDER_WINDOW_BYTES, liveGeometry, renderPaneScreen, type AwaitingFrame, type RenderablePane } from './AwaitingScreenVerifier';
import { enqueueSnapshotJob, generateTextSnapshotUnqueued, runSmallSnapshotJob } from './HeadlessSnapshot';
import { UNKNOWN_CELL } from './sessionTextReplay';
import { joinWrappedRows } from './web/hostSearch';
import type { DaemonPipeServer } from './DaemonPipeServer';
import type { DaemonSessionState } from './types';

/**
 * Whether a session's own output shows an agent's folder-trust dialog:
 *   - 'trust': the dialog is the live screen;
 *   - 'clear': it is not, or nothing runs in the session;
 *   - 'unknown': the screen could not be read in time or whole, or it shows a
 *     trust question over choices a narrow pane cut too short to read.
 */
export type FolderTrustState = 'trust' | 'clear' | 'unknown';

/** How long the verdict waits for the screen parse. */
export const FOLDER_TRUST_READ_TIMEOUT_MS = 250;

/** Room above the tail window for the mode preamble and the unknown-cell fill. */
const TAIL_SLACK_BYTES = 64 * 1024;

/** Rows from a dialog's question to the last row with content: the tallest
 *  measured is 40 (Gemini CLI at 18 columns: 36 to its box's bottom edge, and
 *  4 more to the end of the notice a first Ctrl+C prints under it). A
 *  constant, since the question itself may be among the cells the ring lost. */
const DIALOG_SPAN_ROWS = 44;

/** What the verdict needs of a session (a ManagedSession). */
export type FolderTrustSession = RenderablePane & {
  meta: { state: DaemonSessionState };
  /** The lifetime byte count: the mark a whole-ring verdict was read at. */
  ringBuffer: { readonly totalBytesWritten: number };
  bridge: { heldOutput(): { data: string; dropped: number } | null };
  /** Resized while muted: the held output was dropped, or mixes sizes. */
  resizedWhileMuted?: boolean;
};

type Snapshot = Parameters<typeof renderPaneScreen>[1];

export interface FolderTrustDeps {
  getSession: (id: string) => FolderTrustSession | undefined;
  timeoutMs?: number;
  /** Injected in tests; defaults to a parse outside the shared snapshot queue
   *  (and, for a whole-ring read, the queue's own parse and budget). A
   *  whole-ring read calls it inside the queue's slot, so it must not queue. */
  snapshot?: Snapshot;
}

/**
 * What a parse of a session's whole ring decided, at the mark and the size it
 * was read at (for a muted session, the mark counts its held output too). The
 * bytes and the sizes they were written at fix the screen, so the verdict
 * holds while the mark, the mute and the size stay the same.
 */
interface WholeRingVerdict {
  mark: number;
  muted: boolean;
  cols: number;
  rows: number;
  state: FolderTrustState;
}

/** The last whole-ring verdict per session, and the read under way. */
const wholeRingVerdicts = new WeakMap<FolderTrustSession, WholeRingVerdict>();
const wholeRingReads = new WeakMap<FolderTrustSession, Promise<WholeRingVerdict | null>>();

/**
 * The verdict for one session, read from the daemon's ring rather than a
 * renderer's screen, so it holds for a pane that is hidden, parked or not
 * attached yet. A session with no process ('suspended', 'dead', or a
 * recovery placeholder) shows no live dialog. A muted one (recovered, not
 * shown yet) holds its newest output outside the ring, so the ring and that
 * held output are read together, or, once the hold dropped some of it, the
 * newest held output alone (see withHeldOutput); after a resize dropped it,
 * the verdict is 'unknown'.
 *
 * The screen is rebuilt like the awaiting verifier's (renderPaneScreen): each
 * stretch of the ring at the size it was written at, a resize during the read
 * rejected, and cells the ring no longer covers marked; a ring larger than
 * the tail window is read from its tail. The parse runs beside the shared
 * snapshot queue, not behind it, and is dropped once the budget is spent.
 *
 * A tail that cannot decide is not the last word (#2855). A renderer that
 * repaints by cell diff (ConPTY, Claude Code) never redraws a cell that did
 * not change, so the cells drawn before the tail read as unknown, and an idle
 * pane prints nothing that would redraw them. The whole ring is then parsed
 * on the shared queue, outside this budget, and its verdict answers every
 * request until the pane prints or is resized.
 */
export async function folderTrustState(deps: FolderTrustDeps, id: string): Promise<FolderTrustState> {
  const session = deps.getSession(id);
  // No process runs under an id the daemon holds no live session for: a
  // recovery placeholder, a record kept only on disk, a closed pane.
  if (!session) return 'clear';
  if (session.meta.state === 'suspended' || session.meta.state === 'dead') return 'clear';
  const readable = readableOutput(session);
  if (!readable) return 'unknown';
  const known = currentWholeRingVerdict(session, readable.mark);
  if (known) return known;
  const { pane } = readable;
  const timeoutMs = deps.timeoutMs ?? FOLDER_TRUST_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let dropped = false;
  const parse: Snapshot = deps.snapshot ?? ((req) => runSmallSnapshotJob(() =>
    generateTextSnapshotUnqueued({ ...req, budgetMs: Math.max(1, deadline - Date.now()) })));
  // Past the deadline no further parse starts, and the one under way stops at its budget.
  let firstRead = true;
  let readWhole = false;
  const snapshot: Snapshot = async (req) => {
    if (dropped) return { ok: false };
    // A whole ring larger than the tail window does not parse within the
    // budget: answer 'budget' at once, so renderPaneScreen reads its tail.
    // A live dialog is the pane's newest output, so the tail holds its draw.
    const whole = firstRead;
    const skipWhole = whole && req.initial.length > AWAITING_RENDER_WINDOW_BYTES + TAIL_SLACK_BYTES;
    firstRead = false;
    if (skipWhole) return { ok: false, reason: 'budget' };
    const outcome = await parse(req);
    if (whole && outcome.ok) readWhole = true;
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
    const frame = await Promise.race([renderPaneScreen(() => (deps.getSession(id) === session ? pane : undefined), snapshot).catch(() => null), timedOut]);
    if (!frame) return 'unknown';
    const state = verdictOf(frame);
    if (state !== 'unknown' || readWhole) return state;
    // Only the tail was read, and it could not decide: wait for the whole
    // ring for what is left of the budget. A read that outlasts it goes on,
    // and its verdict answers the next request. A read already under way
    // from before this tail's bytes does not answer for them.
    const wholeRing = await Promise.race([readWholeRing(deps, id, session), timedOut]);
    return wholeRing && wholeRing.mark >= frame.mark ? wholeRing.state : 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** A frame's verdict: the dialog on it, or an unseen cell where one would be. */
function verdictOf(frame: AwaitingFrame): FolderTrustState {
  const lines = joinWrappedRows(frame.rows.map((text, i) => ({ text, wrapped: frame.wrapped?.[i] === true })), frame.cols);
  const onScreen = readFolderTrustScreen(lines.slice(-60));
  if (onScreen === 'trust') return 'trust';
  if (onScreen === 'unreadable') return 'unknown';
  return frame.unknown && unknownWhereADialogWouldBe(frame.unknown) ? 'unknown' : 'clear';
}

/** The whole-ring verdict, while the output holds no newer byte (`mark`), the mute is unchanged and the size is the one it was read at. */
function currentWholeRingVerdict(session: FolderTrustSession, mark: number): FolderTrustState | null {
  const known = wholeRingVerdicts.get(session);
  if (!known || known.mark !== mark || known.muted !== session.bridge.isMuted) return null;
  const size = liveGeometry(session);
  return size && size.cols === known.cols && size.rows === known.rows ? known.state : null;
}

/**
 * Parse the session's whole ring on the shared snapshot queue, under the
 * queue's own budget rather than a request's, and keep its verdict (see
 * currentWholeRingVerdict). The ring is read when the job's turn comes; one
 * read per session at a time, joined by any request while it runs. A ring
 * that does not parse whole in that budget (about 2 s for a full 8 MB ring
 * at the measured 4 MB/s) is kept as 'unknown' too: the same bytes would
 * parse no better, and the queue is shared.
 */
function readWholeRing(deps: FolderTrustDeps, id: string, session: FolderTrustSession): Promise<WholeRingVerdict | null> {
  const running = wholeRingReads.get(session);
  if (running) return running;
  const read = enqueueSnapshotJob(async () => {
    const size = liveGeometry(session);
    // renderPaneScreen reads the ring before its first await, at this mark.
    const readable = readableOutput(session);
    if (!size || !readable) return null;
    const muted = session.bridge.isMuted;
    const live = (): RenderablePane | undefined => (deps.getSession(id) === session && session.bridge.isMuted === muted ? readable.pane : undefined);
    const frame = await renderPaneScreen(live, deps.snapshot ?? generateTextSnapshotUnqueued, { tail: false }).catch(() => null);
    const verdict: WholeRingVerdict = { mark: frame?.mark ?? readable.mark, muted, cols: size.cols, rows: size.rows, state: frame ? verdictOf(frame) : 'unknown' };
    wholeRingVerdicts.set(session, verdict);
    return verdict;
  }).catch(() => null).finally(() => wholeRingReads.delete(session));
  wholeRingReads.set(session, read);
  return read;
}

/**
 * What a read parses, and the mark it is read at: the session itself, or,
 * while it is muted, its ring and the output held outside it. Null when a
 * resize while muted dropped that output, or mixed it with output at the old
 * size.
 */
function readableOutput(session: FolderTrustSession): { pane: RenderablePane; mark: number } | null {
  if (!session.bridge.isMuted) return { pane: session, mark: session.ringBuffer.totalBytesWritten };
  const held = session.bridge.heldOutput();
  return held && !session.resizedWhileMuted ? withHeldOutput(session, held) : null;
}

/**
 * A muted session as the parse sees it, at the size the ring last recorded
 * (no resize while muted), and no longer muted: its ring followed by the
 * output held outside it. Once the hold dropped some, the newest held output
 * is read alone, like a ring that lost its oldest bytes: a cell it does not
 * draw is unknown (withUnknownCells). The mark counts all of it.
 */
function withHeldOutput(session: FolderTrustSession, held: { data: string; dropped: number }): { pane: RenderablePane; mark: number } {
  const bytes = Buffer.from(held.data);
  const mark = session.ringBuffer.totalBytesWritten + held.dropped + bytes.length;
  if (held.dropped > 0) {
    // Start on a line, or at an escape sequence, as a ring's tail does: the
    // oldest chunk kept may begin inside a sequence.
    const nl = bytes.indexOf(0x0a);
    const esc = nl === -1 ? bytes.indexOf(0x1b) : -1;
    const data = bytes.subarray(nl !== -1 ? nl + 1 : esc !== -1 ? esc : bytes.length);
    return {
      pane: {
        meta: session.meta,
        ptyProcess: session.ptyProcess,
        ringBuffer: { readAllWithGeometry: () => ({ data, geometry: undefined, writtenAt: mark }) },
        // The modes the dropped output set are unknown; the ring's are older.
        bridge: { isMuted: false, outputModes: null },
      },
      mark,
    };
  }
  return {
    pane: {
      meta: session.meta,
      ptyProcess: session.ptyProcess,
      ringBuffer: {
        readAllWithGeometry: () => {
          const ring = session.ringBuffer.readAllWithGeometry();
          return { ...ring, data: Buffer.concat([ring.data, bytes]), writtenAt: ring.writtenAt + bytes.length };
        },
      },
      bridge: { isMuted: false, outputModes: session.bridge.outputModes },
    },
    mark,
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

/** A key a daemon writer did not send: the pane is on a folder-trust prompt
 *  ('trust'), or cannot rule one out ('unknown'). */
export class FolderTrustRefusedError extends Error {
  constructor(readonly verdict: 'trust' | 'unknown') {
    super(`folder-trust ${verdict}`);
  }
}
