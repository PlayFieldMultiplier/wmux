import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { t } from '../../i18n';
import type { PcRailBridge } from '../../../preload/preload';

/** How long to wait for the new workspace's row before leaving it to the list. */
const ROW_WAIT_MS = 30_000;

/**
 * The sidebar's `+` for a paired computer: creates a workspace ON that host
 * (a real shell pane there, through REMOTE_WORKSPACE_CREATE), asks the rail to
 * poll the host now, and opens the workspace once its row arrives. Only hosts
 * whose roster entry says `canCreateWorkspace` offer it; nothing local is made.
 */
export function useRemoteWorkspaceCreate(hostId: string | null): {
  canCreate: boolean;
  creating: boolean;
  create: () => void;
} {
  const canCreate = useStore((s) => !!hostId && s.pcRailHosts.some((h) => h.id === hostId && h.canCreateWorkspace === true));
  const [creating, setCreating] = useState(false);
  const stopWaiting = useRef<(() => void) | null>(null);
  // The host this sidebar shows now; null once unmounted. A create that
  // answers after the person moved on opens nothing and changes no route.
  const liveHost = useRef<string | null>(hostId);
  useEffect(() => {
    liveHost.current = hostId;
    return () => {
      liveHost.current = null;
      stopWaiting.current?.();
    };
  }, [hostId]);

  const create = useCallback(() => {
    const remote = window.electronAPI?.remote;
    if (!hostId || creating || !remote?.workspaceCreate) return;
    setCreating(true);
    const workspaceId = crypto.randomUUID();
    void (async () => {
      try {
        const res = await remote.workspaceCreate(hostId, workspaceId);
        if (!res.ok) {
          if (res.reason === 'auth-rejected') useStore.getState().setRemoteHostAuthRejected(hostId, true);
          useStore.getState().pushToast({ message: t('remote.createWorkspaceFailed', { error: res.error }), level: 'error' });
          return;
        }
      } catch (err) {
        useStore.getState().pushToast({
          message: t('remote.createWorkspaceFailed', { error: err instanceof Error ? err.message : String(err) }),
          level: 'error',
        });
        return;
      } finally {
        setCreating(false);
      }
      if (liveHost.current !== hostId) return;
      openWhenListed(hostId, workspaceId, stopWaiting);
      const pcRail = (window.electronAPI as unknown as { pcRail?: PcRailBridge } | undefined)?.pcRail;
      void pcRail?.refresh?.({ hostId }).catch(() => undefined);
    })();
  }, [hostId, creating]);

  return { canCreate, creating, create };
}

/** Open the shadow workspace as soon as the host lists it; give up after ROW_WAIT_MS. */
function openWhenListed(hostId: string, workspaceId: string, stopWaiting: { current: (() => void) | null }): void {
  stopWaiting.current?.();
  const tryOpen = (): boolean => {
    const st = useStore.getState();
    // The person switched computers meanwhile: the row is listed there, nothing opens.
    if (st.pcRail.activePcId !== hostId) return true;
    if (!st.pcRailFeeds[hostId]?.workspaces.some((w) => w.id === workspaceId)) return false;
    if (st.openShadowWorkspace(hostId, workspaceId) === null) return false;
    st.setAppRoute('workspaces');
    return true;
  };
  if (tryOpen()) return;
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.pcRailFeeds !== prev.pcRailFeeds && tryOpen()) stop();
  });
  const timer = setTimeout(() => stop(), ROW_WAIT_MS);
  const stop = () => {
    unsubscribe();
    clearTimeout(timer);
    if (stopWaiting.current === stop) stopWaiting.current = null;
  };
  stopWaiting.current = stop;
}
