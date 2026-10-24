import type { BrowserWindow } from 'electron';
import type { AgentStatus } from '../../shared/types';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import {
  broadcastMetadataUpdate,
  getLastBroadcastAgentStatus,
  hasOutstandingRunningClaim,
} from '../ipc/handlers/metadata.handler';
import { isByteIdle, markSettled } from './idleSuppression';

/**
 * The statuses a settle edge must never overwrite (the F5 rule, shared by the
 * process-death edge, the OSC 133 back-at-prompt edge and the interrupt edge):
 * they are RESULTS the operator has not read yet, and neither the agent
 * exiting nor its shell returning to a prompt un-finishes the turn that
 * reported them.
 */
const UNREAD_RESULT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'complete',
  'awaiting_input',
  'waiting',
  'error',
]);

export function holdsUnreadResult(ptyId: string): boolean {
  const last = getLastBroadcastAgentStatus(ptyId);
  return last !== undefined && UNREAD_RESULT_STATUSES.has(last);
}

/**
 * #1463 — an UNLATCHED pane the renderer may still paint 'running': a byte or
 * activity claim went out, no settle withdrew it, and no unread result stands.
 * The renderer holds that claim for up to 120 s through an unmarked idle, so a
 * settle edge that proves the agent is gone has to withdraw it too.
 */
export function holdsUnsettledRunningClaim(ptyId: string): boolean {
  return hasOutstandingRunningClaim(ptyId) && !holdsUnreadResult(ptyId);
}

/**
 * Broadcast one settle: `agentStatus:'idle'` MARKED as a turn end.
 *
 * Every main-side settle edge sends its idle through here — the interrupt
 * keystroke, the OSC 133 back-at-prompt marker, the agent process's death, and
 * the latch expiry — because an unmarked idle is not enough to clear the pane.
 * 'running' has two carriers in the renderer: the turn latch, which a plain
 * idle ends, and `surfaceActivityAt`, a 120-second freshness stamp the byte
 * heuristic writes and no status broadcast touched. Live-observed: an
 * interrupted pane stayed amber for the rest of that window even though main
 * had already settled it. `settled` is what tells the renderer to clear both.
 *
 * `markSettled` closes the same hole on this side: the redraw that follows
 * every settle would otherwise re-broadcast byte-'running' immediately.
 */
export function broadcastSettledIdle(
  ptyId: string,
  win: BrowserWindow | null,
  now: number = Date.now(),
): void {
  if (!ptyId) return;
  markSettled(ptyId, now);
  broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', settled: true });
}

/**
 * Settle a LATCHED pane to idle. The one funnel every main-side settle edge
 * goes through, so they cannot drift apart.
 *
 * Only a latched pane is touched: the latch is the claim these edges exist to
 * withdraw, and a pane that never had one is still the byte heuristic's to
 * write. The latch is released FIRST, exactly as the death edge does it, so the
 * broadcast is not vetoed by the gate it exists to escape — and it is released
 * even when the broadcast is withheld, because the turn is over either way.
 *
 * Returns true when the pane held a latch (whether or not the broadcast went
 * out) so callers can log/test the edge.
 */
export function settleHookTurnToIdle(
  ptyId: string,
  router: HookSignalRouter | null,
  win: BrowserWindow | null,
  now: number = Date.now(),
): boolean {
  if (!ptyId) return false;
  if (!router?.governsRunningState(ptyId, now)) return false;
  router.releaseHookTurnStart(ptyId);
  // The F5 guard: a turn that already reported a result is not un-finished.
  // The byte-'running' mute still applies — the redraw comes either way, and
  // re-lighting a pane that holds an unread result is the same regression.
  if (holdsUnreadResult(ptyId)) {
    markSettled(ptyId, now);
    return true;
  }
  broadcastSettledIdle(ptyId, win, now);
  return true;
}

/**
 * Settle a pane whose agent confirmed a lone Escape as an interrupt (its
 * "Interrupted" row, or Claude Code's idle title, right after the key).
 *
 * A latched pane settles through `settleHookTurnToIdle`. An UNLATCHED pane
 * (#2673: no UserPromptSubmit hook, so no turn start ever claimed the latch)
 * still has the renderer holding a running claim on its 120 s activity stamp,
 * and no Stop hook follows an interrupt to withdraw it. The agent's own
 * confirmation is proof the turn ended, so that claim is settled too, exactly
 * as the process-death edge does. A pane showing an unread result or a dialog
 * (`awaiting_input`) is left as it is. True when the pane was settled.
 */
export function settleConfirmedInterrupt(
  ptyId: string,
  router: HookSignalRouter | null,
  win: BrowserWindow | null,
  now: number = Date.now(),
): boolean {
  if (settleHookTurnToIdle(ptyId, router, win, now)) return true;
  if (!ptyId || !holdsUnsettledRunningClaim(ptyId)) return false;
  broadcastSettledIdle(ptyId, win, now);
  return true;
}

/**
 * The one way main says `running` for an agent turn the daemon reports (its
 * `agent.turn` edge, a mid-turn idle edge, a resubscribe's snapshot): never
 * over a pane waiting on a human, which shows `awaiting_input` (an approval,
 * or a question with its `pendingQuestion`). The daemon withholds those too;
 * this guards what main is showing. False when withheld.
 */
export function broadcastTurnRunning(
  ptyId: string,
  win: BrowserWindow | null,
  extra: { daemonTurnOpen?: true; agentName?: string } = {},
): boolean {
  if (!ptyId || getLastBroadcastAgentStatus(ptyId) === 'awaiting_input') return false;
  broadcastMetadataUpdate(win, { ptyId, agentStatus: 'running', ...extra });
  return true;
}

/**
 * The daemon's agent turn ended. A pane still printing gets its own idle edge
 * later; a byte-idle one gets none (that edge was spent while the turn ran, or
 * the turn never printed), so it is settled here. Only a pane still showing
 * this turn's `running`: a result, a waiting prompt or a dialog stands. True
 * when settled.
 */
export function settleEndedDaemonTurn(ptyId: string, win: BrowserWindow | null, now: number = Date.now()): boolean {
  if (!ptyId || !isByteIdle(ptyId) || getLastBroadcastAgentStatus(ptyId) !== 'running') return false;
  broadcastSettledIdle(ptyId, win, now);
  return true;
}
