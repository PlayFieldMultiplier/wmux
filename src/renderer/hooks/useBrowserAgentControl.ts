import { useSyncExternalStore } from 'react';
import type {
  BrowserAgentControlIntent,
  BrowserAgentControlState,
} from '../../shared/browserAgentControl';

// ─── The renderer's copy of main's per-tab agent control ─────────────────────
//
// Main owns the state (BrowserAgentControl); this module only mirrors it. One
// subscription for the whole renderer, installed by the first reader, so the
// pane, its toolbar and its tab never hold copies that disagree. Only tabs that
// are not idle are kept: an idle agent tab is the absence of a record.

const states = new Map<string, BrowserAgentControlState>();
const listeners = new Set<() => void>();
let installed = false;

function store(state: BrowserAgentControlState): void {
  if (!state.active && state.mode === 'agent') states.delete(state.surfaceId);
  else states.set(state.surfaceId, state);
  for (const listener of listeners) listener();
}

function install(): void {
  if (installed) return;
  const api = window.electronAPI?.browser?.agentControl;
  if (!api) return;
  installed = true;
  // A push that lands before the initial list is newer than the list's copy.
  const pushed = new Set<string>();
  api.onChanged((state) => {
    pushed.add(state.surfaceId);
    store(state);
  });
  void api
    .list()
    .then((list) => {
      for (const state of list) if (!pushed.has(state.surfaceId)) store(state);
    })
    .catch(() => {
      /* the pushes still arrive */
    });
}

function subscribe(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab's agent control state, or undefined while it is idle. */
export function useBrowserAgentControl(surfaceId: string): BrowserAgentControlState | undefined {
  return useSyncExternalStore(subscribe, () => states.get(surfaceId));
}

/** Send one user intent to main; the answer (and main's push) updates the copy. */
export async function sendBrowserAgentIntent(
  surfaceId: string,
  intent: BrowserAgentControlIntent,
): Promise<void> {
  const api = window.electronAPI?.browser?.agentControl;
  if (!api) return;
  try {
    const res = await api.intent(surfaceId, intent);
    if (res.ok && res.state) store(res.state);
  } catch {
    /* main's push is the authority; a lost reply changes nothing */
  }
}

/** Test seam: forget the copy and the subscription. */
export function resetBrowserAgentControlForTests(): void {
  states.clear();
  listeners.clear();
  installed = false;
}
