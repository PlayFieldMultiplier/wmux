/**
 * The browser build's shell (wmux web `/app`): the desktop's own Sidebar /
 * MiniSidebar and WorkspaceViewport (PaneContainer → Pane → SurfaceTabs),
 * without the desktop-only chrome AppLayout mounts around them (titlebar,
 * channel dock, dialogs, IPC hooks).
 *
 * Phone width: the rail (MiniSidebar) stays, the full Sidebar opens as a drawer
 * over the content, and only the focused pane is shown — it reuses the app's
 * own pane zoom, and a pane picker switches which pane that is. The desktop's
 * split is kept in the store untouched; at 390 px it would be unreadable.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores';
import Sidebar from '../components/Sidebar/Sidebar';
import MiniSidebar from '../components/Sidebar/MiniSidebar';
import { WorkspaceViewport } from '../components/Layout/WorkspaceViewport';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getLeafPanes } from '../../shared/paneUtils';
import { FOCUS_RING } from '../components/focusRing';
import { IconPlus } from '../components/icons';
import { useT } from '../hooks/useT';
import { useWebInputState, webPtyHub } from './WebTerminal';
import { newTerminalTarget, type NewTerminalTarget } from './webPty';
import { desktopOwnsLayout, subscribeDesktopLayout } from './webSync';

export const PHONE_QUERY = '(max-width: 640px)';

function subscribeNarrow(cb: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(PHONE_QUERY).matches);
}

/** Phone only: which pane of the active workspace is shown. */
function PanePicker() {
  const leaves = useStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    if (!ws) return [] as string[];
    return getLeafPanes(ws.rootPane).map((l) => {
      const tab = l.surfaces.find((x) => x.id === l.activeSurfaceId) ?? l.surfaces[0];
      return `${l.id}\u0000${tab?.title ?? ''}`;
    });
  }));
  const activePaneId = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.activePaneId ?? '');
  const setActivePane = useStore((s) => s.setActivePane);
  if (leaves.length < 2) return null;
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto px-2 py-1 border-b" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-mantle)' }} data-web-pane-picker>
      {leaves.map((entry, i) => {
        const [id, title] = entry.split('\u0000');
        const active = id === activePaneId;
        return (
          <button
            key={id}
            type="button"
            className={`shrink-0 max-w-[40vw] truncate rounded px-2 py-1 text-xs ${FOCUS_RING}`}
            style={{ color: active ? 'var(--text-main)' : 'var(--text-sub2)', background: active ? 'var(--bg-surface)' : 'transparent' }}
            aria-pressed={active}
            onClick={() => setActivePane(id)}
          >
            {`${i + 1} · ${title || 'Pane'}`}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Says when this page cannot type: a read-only device or server, or the grant
 * not read yet. Neutral, not accent — a state, not an action (DESIGN.md).
 */
function InputStateChip() {
  const t = useT();
  const state = useWebInputState();
  if (state === 'allowed') return null;
  return (
    <div
      className="pointer-events-none absolute bottom-2 right-3 rounded border px-2 py-0.5 text-[11px]"
      style={{ zIndex: 'var(--z-overlay)' as unknown as number, borderColor: 'var(--border)', background: 'var(--bg-mantle)', color: 'var(--text-sub)' }}
      role="status"
      data-web-input-state={state}
    >
      {state === 'read-only' ? t('web.appReadOnly') : t('web.inputChecking')}
    </div>
  );
}

/** How long the page waits for a new pane to show up in the poll before it stops trying to select it. */
const NEW_TERMINAL_SELECT_MS = 15_000;
/** How long a failed create's message stays up. */
const NEW_TERMINAL_ERROR_MS = 8_000;
/** The name of the workspace the first terminal starts (the self-host image uses the same). */
const FIRST_WORKSPACE_NAME = 'main';

/** A workspace minted by a create no poll has listed yet: a retry reuses it. */
let pendingTarget: NewTerminalTarget | undefined;
/** Cancels the selection still waiting for the last created pane. */
let cancelPendingSelect: (() => void) | undefined;

/**
 * Select the new pane's tab once the poll has brought it in. Gives up when
 * the user moves to another workspace first: a late pane must not pull them
 * back. One wait at a time; a newer create replaces it.
 */
function selectWhenListed(ptyId: string, workspaceId: string, startedOn: string): void {
  cancelPendingSelect?.();
  // Moved while the create was in flight: leave them where they went.
  const movedAway = (active: string) => active !== startedOn && active !== workspaceId;
  if (movedAway(useStore.getState().activeWorkspaceId)) return;
  const trySelect = (): boolean => {
    const s = useStore.getState();
    for (const ws of s.workspaces) {
      for (const leaf of getLeafPanes(ws.rootPane)) {
        const surface = leaf.surfaces.find((x) => x.ptyId === ptyId);
        if (!surface) continue;
        if (s.activeWorkspaceId !== ws.id) s.setActiveWorkspace(ws.id);
        // The phone shows only the active pane, so the leaf must become it too.
        s.setActivePane(leaf.id);
        s.setActiveSurface(leaf.id, surface.id, ws.id);
        return true;
      }
    }
    return false;
  };
  if (trySelect()) return;
  const done = () => {
    clearTimeout(timer);
    unsubscribe();
    if (cancelPendingSelect === done) cancelPendingSelect = undefined;
  };
  const timer = setTimeout(done, NEW_TERMINAL_SELECT_MS);
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.activeWorkspaceId !== prev.activeWorkspaceId && movedAway(state.activeWorkspaceId)) return done();
    if (state.workspaces !== prev.workspaces && trySelect()) done();
  });
  cancelPendingSelect = done;
}

/** The daemon's refusal as the page words it. */
function newTerminalError(t: ReturnType<typeof useT>, result: { code: string; detail?: string }): string {
  if (result.code === 'offline') return t('web.newTerminalOffline');
  // A paired device may add panes to a workspace it can see running, but not
  // start a new one; the daemon's own wording is about its API, not this page.
  if (result.code === 'unknown-workspace-id') return t('web.newTerminalNoWorkspaceGrant');
  return t('web.newTerminalFailed', { reason: result.detail ?? result.code });
}

/**
 * Starts a shell pane (`POST /api/sessions`). Shown only while this page may
 * type, since the daemon gates creating a shell on the same grant, and only on
 * a headless daemon: with a desktop attached it owns the tree and would never
 * place the pane (see webSync's `desktopOwnsLayout`).
 */
function NewTerminalButton({ variant }: { variant: 'primary' | 'icon' }) {
  const t = useT();
  const state = useWebInputState();
  const desktop = useSyncExternalStore(subscribeDesktopLayout, desktopOwnsLayout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(''), NEW_TERMINAL_ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);
  if (state !== 'allowed' || desktop) return null;

  const create = async () => {
    const hub = webPtyHub();
    if (!hub || busy) return;
    setBusy(true);
    setError('');
    const s = useStore.getState();
    const ids = s.workspaces.map((w) => w.id);
    if (ids.length > 0) pendingTarget = undefined;
    const target = newTerminalTarget(s.activeWorkspaceId, ids, FIRST_WORKSPACE_NAME, pendingTarget);
    if (target.workspaceName) pendingTarget = target;
    const result = await hub.createTerminal(target);
    setBusy(false);
    if (result.ok) selectWhenListed(result.id, target.workspaceId, s.activeWorkspaceId);
    else setError(newTerminalError(t, result));
  };

  const errorLine = error && (
    <div className="max-w-[34ch] text-xs" style={{ color: 'var(--text-sub)' }} role="alert" data-web-new-terminal-error>{error}</div>
  );
  if (variant === 'primary') {
    return (
      <div className="flex flex-col items-center gap-2">
        <button type="button" className={`ui-btn ui-btn-primary ${FOCUS_RING}`} disabled={busy} onClick={() => { void create(); }} data-web-new-terminal>
          <IconPlus size={14} />{t('web.newTerminal')}
        </button>
        {errorLine}
      </div>
    );
  }
  return (
    <div className="absolute right-3 top-2 flex flex-col items-end gap-1" style={{ zIndex: 'var(--z-overlay)' as unknown as number }}>
      <button
        type="button"
        className={`ui-icon-btn h-7 w-7 ${FOCUS_RING}`}
        style={{ background: 'var(--bg-mantle)', border: '1px solid var(--border)' }}
        disabled={busy}
        onClick={() => { void create(); }}
        title={t('web.newTerminal')}
        aria-label={t('web.newTerminal')}
        data-web-new-terminal
      ><IconPlus size={15} /></button>
      {errorLine}
    </div>
  );
}

/** No workspace yet (a fresh headless server): say so, and offer the first terminal. */
function EmptyState() {
  const t = useT();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center" data-web-empty>
      <div className="text-sm font-semibold" style={{ color: 'var(--text-main)' }}>{t('web.noTerminals')}</div>
      <div className="max-w-[40ch] text-xs" style={{ color: 'var(--text-sub)' }}>{t('web.noTerminalsBody')}</div>
      <NewTerminalButton variant="primary" />
    </div>
  );
}

export function WebApp() {
  const narrow = useNarrow();
  const hasWorkspaces = useStore((s) => s.workspaces.length > 0);
  const paneGateReady = useStore((s) => s.paneGate === 'ready');
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activePaneId = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.activePaneId ?? null);

  // Phone: one pane at a time, through the app's own zoom.
  useEffect(() => {
    useStore.setState({ zoomedPaneId: narrow ? activePaneId : null });
  }, [narrow, activePaneId]);

  // Phone: the drawer starts closed and closes after a workspace is picked.
  useEffect(() => {
    if (narrow) useStore.getState().setSidebarVisible(false);
  }, [narrow, activeWorkspaceId]);

  return (
    <ErrorBoundary name="WebApp">
      <div className="flex flex-col h-screen w-screen bg-[var(--bg-base)] overflow-hidden" data-web-app>
        <div className="wmux-shell-body relative flex flex-1 min-h-0">
          <ErrorBoundary name="Sidebar">
            {narrow ? <MiniSidebar /> : sidebarVisible ? <Sidebar /> : <MiniSidebar />}
          </ErrorBoundary>
          {narrow && sidebarVisible && (
            <div className="absolute inset-0 flex" style={{ zIndex: 'var(--z-overlay)' as unknown as number }} data-web-drawer>
              <ErrorBoundary name="SidebarDrawer">
                <Sidebar />
              </ErrorBoundary>
              <button
                type="button"
                className="flex-1"
                style={{ background: 'rgba(0,0,0,0.45)' }}
                aria-label="Close sidebar"
                onClick={() => useStore.getState().setSidebarVisible(false)}
              />
            </div>
          )}
          <ErrorBoundary name="Main">
            <div className="flex-1 min-w-0 flex flex-col relative">
              {narrow && <PanePicker />}
              <div className="wmux-workspace-frame flex-1 min-h-0 relative">
                <div className="absolute inset-0 flex flex-col" data-pane-grid-wrapper>
                  <WorkspaceViewport />
                </div>
                {/* Until the first poll answers, "no workspaces" is not known yet. */}
                {paneGateReady && !hasWorkspaces && <EmptyState />}
                {hasWorkspaces && <NewTerminalButton variant="icon" />}
                <InputStateChip />
              </div>
            </div>
          </ErrorBoundary>
        </div>
      </div>
    </ErrorBoundary>
  );
}
