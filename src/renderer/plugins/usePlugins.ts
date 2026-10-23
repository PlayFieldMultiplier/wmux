import { useEffect, useState } from 'react';
import type { PluginHostPluginSummary } from '../../shared/pluginHost';
import { railPagePlugins } from './railPagePlugins';

/** A loaded bundle; `managed` when the catalog installed it (main's install ledger). */
export type ListedPlugin = PluginHostPluginSummary & { managed?: boolean };

interface PluginListState {
  plugins: ListedPlugin[];
  failures: Array<{ name: string; errors: string[] }>;
  loaded: boolean;
}

const EMPTY: PluginListState = { plugins: [], failures: [], loaded: false };
let cache: PluginListState | null = null;
let inflight: Promise<PluginListState> | null = null;
let generation = 0;
let unsubscribeRuntime: (() => void) | null = null;
const listeners = new Set<(s: PluginListState) => void>();

async function fetchPlugins(): Promise<PluginListState> {
  if (!window.electronAPI?.plugins) return { ...EMPTY, loaded: true };
  if (cache) return cache;
  if (!inflight) {
    const epoch = generation;
    inflight = window.electronAPI.plugins.list().then((res) => {
      if (epoch !== generation) return listeners.size ? fetchPlugins() : EMPTY;
      cache = { plugins: (res.plugins as ListedPlugin[]) ?? [], failures: res.failures ?? [], loaded: true };
      return cache;
    }).catch(() => {
      if (epoch !== generation) return listeners.size ? fetchPlugins() : EMPTY;
      inflight = null;
      return { ...EMPTY, loaded: true };
    });
  }
  return inflight;
}

function publish(state: PluginListState): void {
  for (const listener of listeners) {
    try { listener(state); } catch { /* A closing host must not block others. */ }
  }
}

/** Retire frames immediately; never let an older list remount a removed bundle. */
export async function refreshPlugins(changedName?: string): Promise<void> {
  const epoch = ++generation;
  const previous = cache;
  cache = null;
  inflight = null;
  if (changedName && previous) publish({ ...previous, plugins: previous.plugins.filter((plugin) => plugin.name !== changedName) });
  const state = await fetchPlugins();
  if (epoch === generation) publish(state);
}

let railNamesFor: PluginListState | null | undefined;
let railNames: ReadonlySet<string> = new Set();

/** The plugins whose rail page the rail lists now (none until the list is read). */
export function listedRailPageNames(): ReadonlySet<string> {
  if (railNamesFor !== cache) {
    railNamesFor = cache;
    railNames = new Set(railPagePlugins(cache?.plugins ?? []).map((p) => p.name));
  }
  return railNames;
}

/** Plugin `name`'s rail page title from the last list read, or null. */
export function cachedRailPageTitle(name: string): string | null {
  return cache?.plugins.find((p) => p.name === name)?.contributes.railPage?.title ?? null;
}

export function usePlugins(): PluginListState {
  const [state, setState] = useState<PluginListState>(cache ?? EMPTY);
  useEffect(() => {
    let cancelled = false;
    const update = (value: PluginListState) => { if (!cancelled) setState(value); };
    if (listeners.size === 0) {
      unsubscribeRuntime = window.electronAPI?.pluginManagement?.onChanged((name) => { void refreshPlugins(name); }) ?? null;
    }
    listeners.add(update);
    void fetchPlugins().then(update);
    return () => {
      cancelled = true;
      listeners.delete(update);
      if (listeners.size === 0) {
        unsubscribeRuntime?.(); unsubscribeRuntime = null;
        generation++; cache = null; inflight = null;
      }
    };
  }, []);
  return state;
}
