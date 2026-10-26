import { useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Loads the operator's custom agents from main once at startup, so the launch
 * rewrites (fan-out, role-bound seeds) know them before any task is spawned.
 * Settings → Roles & fan-out updates the store after each save.
 */
export function useCustomAgentsHydration(): void {
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.fanout?.getCustomAgents?.()
      .then((report) => {
        if (!cancelled && report && Array.isArray(report.agents)) useStore.getState().setCustomAgents(report.agents);
      })
      .catch(() => {
        // No list: no custom agent is launched, which is the safe side.
      });
    return () => {
      cancelled = true;
    };
  }, []);
}
