// #2398 — whether a surface is on screen, in the sense that decides when its
// shell starts. A blank terminal surface creates its pty only once this is
// true (Terminal.tsx); until then it is `deferred`. On a cold start with many
// restored workspaces this is what keeps the panes nobody opened from each
// starting a shell at mount.
//
// Shown means: its workspace is shown (the active one, a tile of the
// multiview grid, or the one the Bots page hosts in its worker panel), and the
// surface is the one its pane draws — the active tab of a stacked pane, or the
// terminal column's tab of a terminal/work split whatever side holds the
// focus. The split's terminal column counts even while the work area is
// expanded over it: it is a background tab of a pane the user is looking at.
// The window's own state (minimized, behind another app) never counts, so a
// start-minimized app keeps its active workspace hot.

import type { StoreState } from '../index';
import type { PaneLeaf } from '../../../shared/types';
import type { DeadPaneRecovery } from '../../../shared/ptyRecovery';
import { findLeafBySurfaceId } from '../../../shared/paneUtils';
import { selectWorkerPanelHost } from '../slices/roomSlice';
import { isTerminalKindSurfaceType, isTerminalSurfaceType, isWorkSurfaceType, pickSplitShownSurfaces } from '../../components/Pane/surfaceKinds';
import { surfacePtyLifecycle } from '../slices/ptyLifecycleSlice';

type ShownState = Pick<StoreState, 'workspaces' | 'activeWorkspaceId' | 'multiviewIds' | 'appRoute' | 'botsWorkerPanel'>;

/** Agents whose recovered panes are resumed automatically on start. */
export const AUTO_RESUME_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** The workspace's panes are drawn: active, a multiview tile, or in the Bots worker panel. */
export function isWorkspaceShown(state: ShownState, workspaceId: string): boolean {
  if (workspaceId === state.activeWorkspaceId) return true;
  // The grid is drawn only while the active workspace is one of its tiles
  // (WorkspaceViewport); a stale multiview entry alone draws nothing.
  const grid = state.multiviewIds;
  if (grid.length >= 2 && grid.includes(state.activeWorkspaceId) && grid.includes(workspaceId)) return true;
  return selectWorkerPanelHost(state) === workspaceId;
}

/** The surface its leaf draws: the active tab, or the split's terminal column. */
export function isSurfaceDrawnInLeaf(leaf: PaneLeaf, surfaceId: string): boolean {
  if (leaf.activeSurfaceId === surfaceId) return true;
  const terminals = leaf.surfaces.filter((s) => isTerminalKindSurfaceType(s.surfaceType));
  const split = terminals.length > 0 && leaf.surfaces.some((s) => isWorkSurfaceType(s.surfaceType));
  return split && pickSplitShownSurfaces(terminals, [], leaf.activeSurfaceId).shownTerminalId === surfaceId;
}

/**
 * Whether the surface is shown (see the file comment). A surface outside the
 * workspace's visible tree (stashed, or moving between panes) is not.
 */
export function isSurfaceShown(state: ShownState, workspaceId: string, surfaceId: string): boolean {
  if (!isWorkspaceShown(state, workspaceId)) return false;
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const leaf = ws ? findLeafBySurfaceId(ws.rootPane, surfaceId) : null;
  return !!leaf && isSurfaceDrawnInLeaf(leaf, surfaceId);
}

/**
 * Owner decision (#2398 §6-2): with resume-on-start on, a hidden pane that
 * replaces a dead Claude Code or Codex session starts at once, so its
 * conversation resumes at boot like a shown one instead of waiting to be
 * opened.
 */
export function resumesOnStart(recovery: DeadPaneRecovery | undefined, resumeOnStart: boolean): boolean {
  return resumeOnStart && !!recovery?.resumeAgent && AUTO_RESUME_AGENTS.has(recovery.resumeAgent);
}

type DeferredState = Pick<StoreState, 'ptyCreateByKey' | 'ptyUnconfirmedById'> & Partial<Pick<StoreState, 'ptyDeferredById'>>;

/**
 * A local terminal surface whose shell has not started: no pty and no create
 * in flight or refused, or a suspended session its hidden pane attached
 * without promoting. Not running, and not dead — agents and RPC reads see it
 * as such (`deferred: true`), and only showing it or a raw terminal write
 * starts it.
 */
export function isSurfaceDeferred(state: DeferredState, surface: Pick<PaneLeaf['surfaces'][number], 'id' | 'ptyId' | 'surfaceType'>): boolean {
  return isTerminalSurfaceType(surface.surfaceType)
    && surfacePtyLifecycle(state, surface.id, surface.ptyId) === 'deferred';
}

/** A pane whose local terminals have none started (and it has one). */
export function isPaneDeferred(state: DeferredState, leaf: PaneLeaf): boolean {
  const terminals = leaf.surfaces.filter((s) => isTerminalSurfaceType(s.surfaceType));
  return terminals.length > 0 && terminals.every((s) => isSurfaceDeferred(state, s));
}
