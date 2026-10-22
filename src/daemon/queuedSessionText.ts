import type { RingBuffer } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';
import { enqueueSnapshotJob, generateTextSnapshotUnqueued, type TextSnapshotOutcome } from './HeadlessSnapshot';
import { snapshotRingTextUnqueued } from './nativeRingSnapshot';
import { readSessionTextReplay } from './sessionTextReplay';

/** What a queued text read needs of a session (a ManagedSession). */
export interface TextReadSession {
  meta: { cols: number; rows: number };
  ringBuffer: RingBuffer;
  bridge: { readonly outputModes: Pick<OutputModeTracker, 'preamble'> | null };
}

/** The session manager's lookup (DaemonSessionManager.getSession). */
export interface TextReadSessions {
  getSession(id: string): TextReadSession | undefined;
}

// One token per session object. A session id is not an identity: a supervised
// restart re-creates a dead pane under the same id (removeTombstone), and so
// does any create that reuses a closed pane's id.
const sessionTokens = new WeakMap<TextReadSession, number>();
let nextSessionToken = 0;

function sessionToken(session: TextReadSession): number {
  let token = sessionTokens.get(session);
  if (token === undefined) {
    token = ++nextSessionToken;
    sessionTokens.set(session, token);
  }
  return token;
}

/**
 * Run `read` on the session `sessionId` names NOW, in the shared
 * concurrency-1 snapshot queue. The session is pinned at the call, the way the
 * phone's scrollback search pins its pane: if it closed, or another session
 * took its id, while the job waited, the read answers null (what a closed
 * pane reads as) instead of the other session's screen. The coalesce key
 * carries the session's token, so a read joins only a waiting read of the
 * same session, never one of an earlier session under the same id.
 */
function queuedSessionRead<T>(
  sessions: TextReadSessions,
  sessionId: string,
  kind: string,
  read: (session: TextReadSession) => Promise<T>,
): Promise<T | null> {
  const pinned = sessions.getSession(sessionId);
  // Already gone: the answer the job would give at its turn, without the wait.
  if (!pinned) return Promise.resolve(null);
  return enqueueSnapshotJob(async () => {
    if (sessions.getSession(sessionId) !== pinned) return null;
    return read(pinned);
  }, `${kind}:${sessionId}#${sessionToken(pinned)}`);
}

/**
 * A plain-text parse of a session's ring on the shared concurrency-1 snapshot
 * queue. The ring is copied only when the job's turn comes, so a job waiting
 * behind attach snapshots pins no ring copy. A read of the same session and
 * depth still waiting joins the queued one (enqueueSnapshotJob's coalesceKey).
 */
export function queuedTextSnapshot(sessions: TextReadSessions, sessionId: string, scrollback: number): Promise<TextSnapshotOutcome | null> {
  return queuedSessionRead(sessions, sessionId, `text:${scrollback}`, (managed) =>
    snapshotRingTextUnqueued(managed.ringBuffer, managed.bridge.outputModes, {
      // Dims backstop parity with the attach flush (?? 80 / ?? 24): a recovered
      // session may not have real dims yet, and a 0-wide headless terminal would
      // fail soft instead of reading.
      cols: managed.meta.cols ?? 80,
      rows: managed.meta.rows ?? 24,
      scrollback,
    }));
}

/**
 * The visible grid of a pane (no scrollback), for the approval check, the chat
 * bridge and automation. Read in the slot like queuedTextSnapshot, so the
 * pollers that call this many times while the queue is busy share one parse
 * per pane instead of each queueing a whole-ring parse of its own.
 */
export function queuedScreenText(sessions: TextReadSessions, sessionId: string, undimmed = false): Promise<TextSnapshotOutcome | null> {
  return queuedSessionRead(sessions, sessionId, `screen:${undimmed ? 'undimmed' : 'plain'}`, (managed) =>
    generateTextSnapshotUnqueued({
      cols: managed.meta.cols ?? 80,
      rows: managed.meta.rows ?? 24,
      scrollback: 0,
      initial: readSessionTextReplay(managed.ringBuffer, managed.bridge.outputModes),
      ...(undimmed ? { undimmed: true } : {}),
    }));
}
