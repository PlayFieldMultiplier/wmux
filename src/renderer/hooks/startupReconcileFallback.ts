/**
 * #2398 — what the startup path does with the saved bindings when its
 * reconcile fails (times out, aborts, or an RPC rejects).
 *
 * With a daemon, a failed reconcile says nothing about whether a session is
 * alive: the daemon was slow or restarting. The old fallback cleared every
 * ptyId, so each Terminal self-created a fresh shell while the daemon still
 * ran (or was about to recover) the old one — duplicate shells, and the old
 * session's scrollback and identity lost. Now every binding is kept and marked
 * unconfirmed; a late reconcile and each Terminal's own reattach clear one
 * only on an authoritative answer (absent from two snapshots, or
 * `session-dead`).
 *
 * Without a daemon (local mode) no pty outlives the app, so a saved id is
 * never alive and the historical wipe stays.
 *
 * Pure and dependency-injected so the decision is unit-testable without
 * AppLayout (which has no jsdom fixture).
 */
import type { Workspace } from '../../shared/types';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';

export interface StartupReconcileFallbackDeps {
  /** Whether this startup attached to a daemon (daemon.whenReady said connected). */
  daemonMode: boolean;
  workspaces: readonly Workspace[];
  markUnconfirmed: (ptyIds: string[]) => void;
  clearAll: () => void;
  log?: (message: string) => void;
}

/** Every pty a surface is bound to, stashed panes included (#977). */
export function collectBoundPtyIds(workspaces: readonly Workspace[]): string[] {
  const ids: string[] = [];
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const s of leaf.surfaces) if (s.ptyId) ids.push(s.ptyId);
    }
  }
  return ids;
}

/**
 * Apply the fallback. Returns 'kept' when the bindings were kept unconfirmed
 * (the caller then schedules a late reconcile), 'cleared' otherwise.
 */
export function applyStartupReconcileFallback(deps: StartupReconcileFallbackDeps): 'kept' | 'cleared' {
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((message: string) => console.warn(message));
  if (!deps.daemonMode) {
    log('[lifecycle] startup reconcile failed without a daemon — clearing pty state for self-create');
    deps.clearAll();
    return 'cleared';
  }
  const ids = collectBoundPtyIds(deps.workspaces);
  deps.markUnconfirmed(ids);
  log(`[lifecycle] startup reconcile failed — keeping ${ids.length} binding(s) unconfirmed; a late reconcile confirms or clears them`);
  return 'kept';
}
