import type { BrowserWindow } from 'electron';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import { agentDisplayToSlug } from '../../shared/agentIdentity';
import { broadcastMetadataUpdate, getLastBroadcastAgentStatus } from '../ipc/handlers/metadata.handler';
import { broadcastSettledIdle, settleHookTurnToIdle } from './turnSettle';

/**
 * #2263 — bring pane state back in line after main subscribes to daemon events
 * again.
 *
 * The daemon drops a subscriber that falls past its backpressure cap but keeps
 * the socket, and the health ping subscribes again (#2244). Everything pushed
 * in between is gone: an `activity.active` that started a turn (it fires once
 * per output cycle), the hook signals that open and close a turn (they ride
 * the same subscription as `agent.event`), detector statuses, titles, cwd
 * changes, and `session.died`. The panes then show what they showed before the
 * gap until their next event, and a pane whose shell exited has no next event:
 * the daemon also closes its session pipe, which main does not read as a death.
 *
 * This reads each pane's state from the daemon once and corrects only where
 * the pane shows something else. A session the daemon lists dead that main
 * still tracks gets the `session:died` it missed, from the tombstone's exit
 * code and signal, so every listener ends it as it would have live. It
 * notifies nobody: a completion or a question from the gap is shown as the
 * pane's status, not replayed as a toast. A second pass right after the first
 * changes nothing.
 */

/** One pane's daemon-side state, as `DaemonClient.getAgentState` reads it. */
export interface DaemonPaneState {
  agentStatus: AgentStatus;
  agentName: string | null;
  /** Absent from an older daemon; '' when the program never set one. */
  title?: string;
  /** A turn is open. A quiet one (thinking, a slow tool) reads `idle` in agentStatus. */
  turnOpen?: boolean;
  /** The pane's current agent has delivered a hook. */
  hookReports?: boolean;
}

/** The `daemon.listSessions` fields the resync reads; raw off the RPC. */
export interface DaemonSessionRow {
  id?: unknown;
  state?: unknown;
  cwd?: unknown;
  exitCode?: unknown;
  exitSignal?: unknown;
}

export interface ResubscribeResyncDeps {
  /** The daemon's sessions, dead ones included (`daemon.listSessions`). */
  listSessions: () => Promise<DaemonSessionRow[]>;
  /**
   * Main's cwd for a session it still tracks; undefined once it heard the
   * session end (or never attached it).
   */
  trackedCwd: (id: string) => string | undefined;
  /** One pane's state, or null when it could not be read. */
  readState: (id: string) => Promise<DaemonPaneState | null>;
  /** Ends a session the way a live `session.died` does. */
  emitDied: (id: string, exitCode: number | null, signal?: number) => void;
  /** Sends a cwd the way a live `cwd.changed` does. */
  emitCwd: (id: string, cwd: string) => void;
  /**
   * Calls back on each live `cwd.changed` ('cwd') and each live death,
   * destroy or supervised restart ('lifecycle'); returns the unsubscribe.
   */
  onLiveEvent: (listener: (kind: 'cwd' | 'lifecycle', id: string) => void) => () => void;
  /** Sends a title to the renderer the way a live `title.changed` does. */
  emitTitle: (id: string, title: string) => void;
  hookRouter: HookSignalRouter | null;
  win: BrowserWindow | null;
  now?: () => number;
}

export interface ResubscribeResyncResult {
  panes: number;
  statusesCorrected: number;
  titles: number;
  deaths: number;
  cwds: number;
}

export async function resyncAfterResubscribe(deps: ResubscribeResyncDeps): Promise<ResubscribeResyncResult> {
  const result: ResubscribeResyncResult = { panes: 0, statusesCorrected: 0, titles: 0, deaths: 0, cwds: 0 };
  // A live event that lands after the daemon took its list, but before the
  // pass acts on it (both can arrive in one socket read), is newer than what
  // was listed or read: a live cwd wins over the listed one, and a pane that
  // died, was destroyed or restarted live is left to that event.
  const liveCwd = new Set<string>();
  const liveLifecycle = new Set<string>();
  const offLive = deps.onLiveEvent((kind, id) => { (kind === 'cwd' ? liveCwd : liveLifecycle).add(id); });
  try {
    return await resync(deps, result, liveCwd, liveLifecycle);
  } finally {
    offLive();
  }
}

async function resync(
  deps: ResubscribeResyncDeps,
  result: ResubscribeResyncResult,
  liveCwd: ReadonlySet<string>,
  liveLifecycle: ReadonlySet<string>,
): Promise<ResubscribeResyncResult> {
  let rows: DaemonSessionRow[];
  try {
    rows = await deps.listSessions();
  } catch {
    return result;
  }
  const ids: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.id;
    if (typeof id !== 'string' || id.length === 0 || liveLifecycle.has(id)) continue;
    const tracked = deps.trackedCwd(id);
    if (row.state === 'dead') {
      // A tombstone's agent state is what it held when the shell went, so it
      // is never read as the pane's status.
      if (tracked === undefined) continue;
      const signal = typeof row.exitSignal === 'number' ? row.exitSignal : undefined;
      let exitCode = typeof row.exitCode === 'number' ? row.exitCode : null;
      // An older daemon keeps no signal, and a killed shell reports code 0:
      // read as a clean exit, that would close the tab. Unknown keeps it.
      if (exitCode === 0 && !('exitSignal' in row)) exitCode = null;
      deps.emitDied(id, exitCode, signal);
      result.deaths += 1;
      continue;
    }
    if (tracked !== undefined && !liveCwd.has(id) && typeof row.cwd === 'string' && row.cwd.length > 0 && row.cwd !== tracked) {
      deps.emitCwd(id, row.cwd);
      result.cwds += 1;
    }
    ids.push(id);
  }
  const states = await Promise.all(ids.map(async (id) => {
    try {
      return [id, await deps.readState(id)] as const;
    } catch {
      return [id, null] as const;
    }
  }));
  for (const [id, state] of states) {
    if (!state) continue;
    if (liveLifecycle.has(id)) continue;
    result.panes += 1;
    if (state.title) {
      deps.emitTitle(id, state.title);
      result.titles += 1;
    }
    if (applyStatus(id, state, deps)) result.statusesCorrected += 1;
  }
  return result;
}

/** Correct one pane's status where it disagrees with the daemon. True when it changed. */
function applyStatus(id: string, state: DaemonPaneState, deps: ResubscribeResyncDeps): boolean {
  const now = deps.now?.() ?? Date.now();
  const shown = getLastBroadcastAgentStatus(id) ?? 'idle';
  // The daemon's status reads the byte rate once no result is settled, so a
  // turn thinking quietly reads `idle` there; an open turn is still running.
  // An older daemon does not say which, and then an idle status is left alone.
  let truth = state.agentStatus;
  if (truth === 'idle') {
    if (state.turnOpen === undefined) return false;
    if (state.turnOpen) truth = 'running';
  }
  if (truth === shown) return false;
  const router = deps.hookRouter;
  const agentName = state.agentName ?? '';

  if (truth === 'running') {
    // A turn started in the gap. Its own later events settle it as usual. A
    // turn the pane's hooks opened also gets the latch its missed running edge
    // would have set, so byte silence mid-turn does not clear it; a turn open
    // without hooks (a boot paint, a bare submit) stays on the byte heuristic.
    if (state.turnOpen && state.hookReports && router && !router.governsRunningState(id, now)) {
      router.noteHookTurnStart(id, now, agentDisplayToSlug(agentName) ?? null);
    }
    broadcastMetadataUpdate(deps.win, { ptyId: id, agentStatus: 'running', agentName });
    return true;
  }
  if (truth === 'idle') {
    // Only a pane still shown running is wrong here: an idle daemon pane that
    // shows a result (complete, waiting, a question) keeps it until it is read.
    if (shown !== 'running') return false;
    // A turn that ended in the gap is over; settled, so the renderer drops its
    // activity stamp too instead of holding the dot lit for two minutes.
    if (!settleHookTurnToIdle(id, router, deps.win, now)) broadcastSettledIdle(id, deps.win, now);
    return true;
  }
  // complete / waiting / error / awaiting_input: the turn reached a result in
  // the gap. Release a latch main still holds, then show the result.
  if (router?.governsRunningState(id, now)) router.releaseHookTurnStart(id);
  broadcastMetadataUpdate(deps.win, { ptyId: id, agentStatus: truth, agentName });
  return true;
}

/**
 * Runs resyncs one at a time. A resubscribe that succeeds while a pass is
 * running asks for one more pass after it (with the latest argument) instead
 * of a second pass interleaved with the first: two passes over the same list
 * could both see a death before either one's `session:died` had dropped the
 * session, and end it twice. Any number of asks during a pass is one rerun.
 */
export function serialResync<T>(run: (arg: T) => Promise<unknown>): (arg: T) => Promise<void> {
  let running: Promise<void> | null = null;
  let pending: { arg: T } | null = null;
  const loop = async (arg: T): Promise<void> => {
    let next: { arg: T } | null = { arg };
    while (next) {
      const current = next;
      pending = null;
      try {
        await run(current.arg);
      } catch {
        /* the caller's run reports its own failure */
      }
      next = pending;
      // Idle in the same step that finds nothing pending: clearing it later
      // (a `.finally`) leaves a microtask gap where an ask only sets
      // `pending`, which no pass then reads.
      if (!next) running = null;
    }
  };
  return (arg: T) => {
    if (running) {
      pending = { arg };
      return running;
    }
    // `loop` awaits a pass before it can clear `running`, so this assignment
    // always comes first.
    running = loop(arg);
    return running;
  };
}
