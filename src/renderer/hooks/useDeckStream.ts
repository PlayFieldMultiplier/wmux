import { useEffect } from 'react';
import { receiveFanoutCallerEvent, receivePrOwnerEvent } from './fanoutCallerNudge';

// ─── Fan-out caller and PR owner nudges ──────────────────────────────────────
//
// The SINGLE owner of the deck's push subscriptions that reach human panes.
// Mounted ONCE in AppLayout, always-on (not gated on the dock being visible).
// The actions are read via useStore.getState() so the effect deps stay [] —
// the subscription is established exactly once per renderer lifetime.
export function useDeckStream(): void {
  useEffect(() => {
    const api = window.electronAPI.deck;
    if (!api) return; // older preload bundles may not expose this channel
    // A fan-out worker of a brain-less owner ended its turn: nudge the pane
    // that started the fan-out (fanoutCallerNudge validates the payload).
    const offFanoutCaller = api.onFanoutCaller?.((ev) => receiveFanoutCallerEvent(ev));
    // A PR event of a brain-less workspace: nudge the pane that owns the PR.
    const offPrOwner = api.onPrOwner?.((ev) => receivePrOwnerEvent(ev));
    return () => {
      offFanoutCaller?.();
      offPrOwner?.();
    };
  }, []);
}
