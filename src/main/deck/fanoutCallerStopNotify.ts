// ─── Worker turn ends → the caller pane, while Moa's runtime is off ─────────
//
// A worker's turn end ("updated" / "stopped on an error") reaches the pane
// that started the fan-out through the deck's EventBus handler
// (routeWorkerEventToOwner → notifyCaller). That handler is subscribed only
// while Moa's runtime runs, so with Moa off a brainless parent was never told
// its worker finished a turn.
//
// This sends the same pointer for exactly that gap. It rides the fan-out
// worker watch's always-on bus subscription (fanoutWorkerWatchHost.ts), stands
// down whenever the deck's own subscription is live (so a Moa-on app never
// sends it twice) and applies the same filters. The renderer's stop cooldown
// (STOP_COOLDOWN_MS) and every check in notifyFanoutCaller still apply.
// Nothing is parked: the park feeds a brain, and there is none.

import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { shouldNotifyCaller } from './fanoutCallerNotify';
import { getTaskLedger } from './taskLedgerHost';

export interface WorkerLifecycleEvent {
  workspaceId: string;
  kind: string;
  source: string;
  decision?: string;
  seq: number;
}

export interface FanoutCallerStopNotifyPorts {
  /** True while the deck's own EventBus subscription runs (it notifies then). */
  deckRuntimeActive: () => boolean;
  hasBrain: (ownerWorkspaceId: string) => boolean;
  notify: (ownerWorkspaceId: string, taskWorkspaceId: string, taskId: string, kind: string, seq: number) => void;
  ledger?: TaskLedger;
}

/** The handler for one agent.lifecycle event. Never throws. */
export function createFanoutCallerStopNotify(ports: FanoutCallerStopNotifyPorts): (ev: WorkerLifecycleEvent) => void {
  return (ev) => {
    if (ports.deckRuntimeActive()) return;
    if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.stop_failure') return;
    if (!shouldNotifyCaller(ev)) return;
    try {
      const entry = (ports.ledger ?? getTaskLedger()).findOpenByTaskWorkspace(ev.workspaceId);
      if (!entry || entry.ownerWorkspaceId === ev.workspaceId) return;
      if (ports.hasBrain(entry.ownerWorkspaceId)) return;
      ports.notify(entry.ownerWorkspaceId, ev.workspaceId, entry.id, ev.kind, ev.seq);
    } catch {
      // best effort
    }
  };
}
