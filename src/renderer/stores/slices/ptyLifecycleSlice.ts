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
 * - `deferred`: not started: blank with nothing in flight, or bound to a
 *   suspended session a hidden pane attached without promoting.
 * - `creating`: one create in flight.
 * - `createFailed`: the create was refused.
 */
export type SurfacePtyLifecycle = 'bound' | 'unconfirmed' | 'deferred' | 'creating' | 'createFailed';

export interface PtyLifecycleSlice {
  /** Per key (surface id, or leaf id for the funnel): a create in flight or refused. */
  ptyCreateByKey: Record<string, PtyCreateAttempt>;
  /**
   * Bound ptys whose binding is kept but unconfirmed, each with the sequence
   * number of its latest mark. Absent = confirmed.
   */
  ptyUnconfirmedById: Record<string, number>;
  /** The sequence number the latest mark took (0 before any). */
  ptyUnconfirmedSeq: number;
  /**
   * #2398 — bound ptys whose suspended session a hidden pane attached without
   * promoting: not started, and not dead. Promoted when the pane is first shown.
   */
  ptyDeferredById: Record<string, true>;
  /** Set or clear (null) one key's create attempt. */
  setPtyCreateAttempt: (key: string, attempt: PtyCreateAttempt | null) => void;
  /**
   * Mark bound ptys unconfirmed (each mark takes a new sequence number, a
   * re-mark included), or confirmed again. `markedAtOrBefore` confirms only
   * marks no newer than that number: a reconcile pass confirms what it found
   * marked when it started, and a mark made while it ran — on evidence it
   * never saw — wins.
   */
  setPtysUnconfirmed: (ptyIds: Iterable<string>, unconfirmed: boolean, opts?: { markedAtOrBefore?: number }) => void;
  /** Mark a bound pty's session deferred (attached without promote), or not. */
  setPtyDeferred: (ptyId: string, deferred: boolean) => void;
}

/** One surface's lifecycle state, from its create key and its bound ptyId. */
export function surfacePtyLifecycle(
  state: Pick<PtyLifecycleSlice, 'ptyCreateByKey' | 'ptyUnconfirmedById'> & Partial<Pick<PtyLifecycleSlice, 'ptyDeferredById'>>,
  key: string,
  ptyId: string | null | undefined,
): SurfacePtyLifecycle {
  if (ptyId) {
    if (state.ptyUnconfirmedById?.[ptyId]) return 'unconfirmed';
    return state.ptyDeferredById?.[ptyId] ? 'deferred' : 'bound';
  }
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
  ptyUnconfirmedSeq: 0,
  ptyDeferredById: {},

  setPtyCreateAttempt: (key, attempt) => {
    const current = get().ptyCreateByKey[key];
    if (!attempt && !current) return;
    set((draft: StoreState) => {
      if (attempt) draft.ptyCreateByKey[key] = attempt;
      else delete draft.ptyCreateByKey[key];
    });
  },

  setPtysUnconfirmed: (ptyIds, unconfirmed, opts) => {
    const map = get().ptyUnconfirmedById;
    const limit = opts?.markedAtOrBefore;
    const changed = [...ptyIds].filter((id) => id && (unconfirmed
      || (map[id] !== undefined && (limit === undefined || map[id] <= limit))));
    if (changed.length === 0) return;
    set((draft: StoreState) => {
      for (const id of changed) {
        if (unconfirmed) draft.ptyUnconfirmedById[id] = ++draft.ptyUnconfirmedSeq;
        else delete draft.ptyUnconfirmedById[id];
      }
    });
  },

  setPtyDeferred: (ptyId, deferred) => {
    if (!ptyId || !!get().ptyDeferredById[ptyId] === deferred) return;
    set((draft: StoreState) => {
      if (deferred) draft.ptyDeferredById[ptyId] = true;
      else delete draft.ptyDeferredById[ptyId];
    });
  },
});
