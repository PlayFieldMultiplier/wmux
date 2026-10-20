import { useEffect, useState } from 'react';
import type { PluginHostPluginSummary } from '../../shared/pluginHost';

interface PluginListState {
  plugins: PluginHostPluginSummary[];
  failures: Array<{ name: string; errors: string[] }>;
  loaded: boolean;
}

// Module-level cache: the loaded plugin set only changes on app restart
// (B-1 core has no hot reload), so every host component shares one fetch.
let cache: PluginListState | null = null;
let inflight: Promise<PluginListState> | null = null;

async function fetchPlugins(): Promise<PluginListState> {
  if (!window.electronAPI?.plugins) return { plugins: [], failures: [], loaded: true };
  if (cache) return cache;
  if (!inflight) {
    inflight = window.electronAPI.plugins
      .list()
      .then((res) => {
        cache = {
          plugins: (res.plugins as PluginHostPluginSummary[]) ?? [],
          failures: res.failures ?? [],
          loaded: true,
        };
        return cache;
      })
      .catch(() => {
        // Main not ready / handler swapped — treat as "no plugins" but do
        // not cache, so a later mount retries.
        inflight = null;
        return { plugins: [], failures: [], loaded: true };
      });
  }
  return inflight;
}

// Subscribers re-rendered by refreshPlugins (trust status changes after an
// approval prompt resolves).
const listeners = new Set<(s: PluginListState) => void>();

/** Drop the cache and re-fetch — call after a trust-status mutation. */
export async function refreshPlugins(): Promise<void> {
  cache = null;
  inflight = null;
  const s = await fetchPlugins();
  for (const fn of listeners) {
    try { fn(s); } catch { /* a broken subscriber must not block the rest */ }
  }
}

/** Loaded UI plugin summaries (empty until the one-shot IPC resolves). */
export function usePlugins(): PluginListState {
  const [state, setState] = useState<PluginListState>(
    cache ?? { plugins: [], failures: [], loaded: false },
  );
  useEffect(() => {
    let cancelled = false;
    const onUpdate = (s: PluginListState) => { if (!cancelled) setState(s); };
    listeners.add(onUpdate);
    void fetchPlugins().then(onUpdate);
    return () => { cancelled = true; listeners.delete(onUpdate); };
  }, []);
  return state;
}
