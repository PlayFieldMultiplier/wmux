// PTY lifecycle state slice (#2398) — what the store knows about each
// surface's pty beyond its ptyId: a create in flight or refused (keyed by
// surface id, or by leaf id for the empty-leaf funnel), and bound ptys whose
// binding could not be checked. The create attempts themselves (one shared
// promise per key, attempt tokens) live in hooks/ptyLifecycle.ts; this slice
// is their mirror for the UI.
//
// All fields are TRANSIENT — none enter buildSessionData's allowlist.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';

/** A create for one key that has not ended in a bound pty. */
export type PtyCreateAttempt =
  | { state: 'creating' }
  /** Refused (spawn error, cap, daemon gone). Stays until Retry; never re-fires by itself. */
  | { state: 'createFailed'; error: string };

/**
 * A surface's pty, as one state:
 * - `bound`: the daemon holds the pty.
 * - `unconfirmed`: a binding kept although it could not be checked
 *   (reconcile timeout, reconnect exhaustion, rate limiting).
 * - `deferred`: blank, nothing in flight.
 * - `creating`: one create in flight.
 * - `createFailed`: the create was refused.
 */
export type SurfacePtyLifecycle = 'bound' | 'unconfirmed' | 'deferred' | 'creating' | 'createFailed';

export interface PtyLifecycleSlice {
  /** Per key (surface id, or leaf id for the funnel): a create in flight or refused. */
  ptyCreateByKey: Record<string, PtyCreateAttempt>;
  /** Bound ptys whose binding is kept but unconfirmed. Absent = confirmed. */
  ptyUnconfirmedById: Record<string, true>;
  /** Set or clear (null) one key's create attempt. */
  setPtyCreateAttempt: (key: string, attempt: PtyCreateAttempt | null) => void;
  /** Mark bound ptys unconfirmed, or confirmed again. */
  setPtysUnconfirmed: (ptyIds: Iterable<string>, unconfirmed: boolean) => void;
}

/** One surface's lifecycle state, from its create key and its bound ptyId. */
export function surfacePtyLifecycle(
  state: Pick<PtyLifecycleSlice, 'ptyCreateByKey' | 'ptyUnconfirmedById'>,
  key: string,
  ptyId: string | null | undefined,
): SurfacePtyLifecycle {
  if (ptyId) return state.ptyUnconfirmedById?.[ptyId] ? 'unconfirmed' : 'bound';
  return state.ptyCreateByKey?.[key]?.state ?? 'deferred';
}

export const createPtyLifecycleSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  PtyLifecycleSlice
> = (set, get) => ({
  ptyCreateByKey: {},
  ptyUnconfirmedById: {},

  setPtyCreateAttempt: (key, attempt) => {
    const current = get().ptyCreateByKey[key];
    if (!attempt && !current) return;
    set((draft: StoreState) => {
      if (attempt) draft.ptyCreateByKey[key] = attempt;
      else delete draft.ptyCreateByKey[key];
    });
  },

  setPtysUnconfirmed: (ptyIds, unconfirmed) => {
    const map = get().ptyUnconfirmedById;
    const changed = [...ptyIds].filter((id) => id && Boolean(map[id]) !== unconfirmed);
    if (changed.length === 0) return;
    set((draft: StoreState) => {
      for (const id of changed) {
        if (unconfirmed) draft.ptyUnconfirmedById[id] = true;
        else delete draft.ptyUnconfirmedById[id];
      }
    });
  },
});
