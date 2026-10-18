/**
 * #2398 — one create path for the ptys that blank surfaces start themselves.
 *
 * `ensure(key, request)` keeps at most one create in flight per key (a
 * surface id, or a leaf id for the empty-leaf funnel). A second call for the
 * same key joins the attempt already running instead of starting another, and
 * the latest caller's `bind` is the one used, so a Terminal that remounts
 * mid-create (a split, a moved tab) binds through its new instance.
 *
 * Only a close or a replace ends an attempt early: `cancel(key)` bumps the
 * key's attempt token and asks main to drop the pending create. A visibility
 * change, an effect re-run or a remount never does. A create that settles
 * under a stale token, or whose owner no longer takes it (`bind` returns
 * false), is disposed and never bound.
 *
 * A refused create leaves the key `createFailed` and never re-fires by
 * itself: only an `ensure` with `retry` (the pane's Retry) starts it again.
 *
 * The state mirror lives in the store (ptyLifecycleSlice); the promises and
 * tokens live here, since neither belongs in a serializable store. Pure
 * factory with injected deps, so the policy is unit-testable without a store
 * or Electron (as reconnectPtyWithRetry.ts).
 */
import type { IpcResult } from './useIpc';
import type { PtyCreateAttempt } from '../stores/slices/ptyLifecycleSlice';
import { useStore } from '../stores';

export interface PtyCreated {
  id: string;
}

export interface PtyEnsureRequest<T extends PtyCreated> {
  /** Starts the create. Called synchronously by ensure, once per attempt. */
  create: () => Promise<IpcResult<T>>;
  /**
   * Binds the created pty to its owner. Returns false when the owner no longer
   * takes it (it closed, or another pty was bound to it meanwhile); the pty is
   * then disposed.
   */
  bind: (created: T) => boolean;
  /** Start again from `createFailed`. Without it a refused key stays refused. */
  retry?: boolean;
}

export type PtyEnsureOutcome =
  | { status: 'bound'; ptyId: string }
  | { status: 'createFailed'; error: string }
  /** Cancelled, or the owner was gone: the pty (if any) was disposed. */
  | { status: 'stale' };

export interface PtyLifecycleDeps {
  getAttempt: (key: string) => PtyCreateAttempt | undefined;
  setAttempt: (key: string, attempt: PtyCreateAttempt | null) => void;
  dispose: (ptyId: string) => void;
  /** Ask main to drop a create that has not spawned yet (best effort). */
  cancelCreate: (surfaceId: string) => void;
  log?: (message: string, err?: unknown) => void;
}

export interface PtyLifecycle {
  ensure: <T extends PtyCreated>(key: string, request: PtyEnsureRequest<T>) => Promise<PtyEnsureOutcome>;
  /** Close or replace: end the key's attempt (if any), so its create is never bound. */
  cancel: (key: string, surfaceId?: string) => void;
  /** A store-wide clear: every attempt in flight is stale. */
  invalidateAll: () => void;
  isInFlight: (key: string) => boolean;
  isRefused: (key: string) => boolean;
  /** Forget a refusal so the next ensure (the funnel's re-run) creates again. */
  clearRefusal: (key: string) => void;
}

interface Attempt {
  token: number;
  bind: (created: PtyCreated) => boolean;
  promise: Promise<PtyEnsureOutcome>;
}

export function createPtyLifecycle(deps: PtyLifecycleDeps): PtyLifecycle {
  const inFlight = new Map<string, Attempt>();
  const tokens = new Map<string, number>();
  const log = deps.log ?? ((message: string, err?: unknown) => {
    // eslint-disable-next-line no-console
    if (err === undefined) console.warn(message); else console.warn(message, err);
  });
  const bump = (key: string) => {
    const next = (tokens.get(key) ?? 0) + 1;
    tokens.set(key, next);
    return next;
  };

  const ensure = <T extends PtyCreated>(key: string, request: PtyEnsureRequest<T>): Promise<PtyEnsureOutcome> => {
    const live = inFlight.get(key);
    if (live) {
      live.bind = request.bind as (created: PtyCreated) => boolean;
      return live.promise;
    }
    const previous = deps.getAttempt(key);
    if (previous?.state === 'createFailed' && !request.retry) {
      return Promise.resolve({ status: 'createFailed', error: previous.error });
    }
    const token = bump(key);
    const attempt = { token, bind: request.bind as (created: PtyCreated) => boolean } as Attempt;
    inFlight.set(key, attempt);
    deps.setAttempt(key, { state: 'creating' });

    const settle = (result: IpcResult<T>): PtyEnsureOutcome => {
      const current = tokens.get(key) === token;
      if (inFlight.get(key) === attempt) inFlight.delete(key);
      if (!result.ok) {
        // The refusal belongs to this key only while no newer attempt replaced it.
        if (current) deps.setAttempt(key, { state: 'createFailed', error: result.error.message });
        return { status: 'createFailed', error: result.error.message };
      }
      const created = result.data;
      if (!current) {
        log(`[ptyLifecycle] ${key}: create settled after a close or replace — disposing ${created.id}`);
        deps.dispose(created.id);
        return { status: 'stale' };
      }
      deps.setAttempt(key, null);
      let bound = false;
      try {
        bound = attempt.bind(created);
      } catch (err) {
        log(`[ptyLifecycle] ${key}: bind threw — disposing ${created.id}`, err);
      }
      if (!bound) {
        deps.dispose(created.id);
        return { status: 'stale' };
      }
      return { status: 'bound', ptyId: created.id };
    };

    let pending: Promise<IpcResult<T>>;
    try {
      pending = request.create();
    } catch (err) {
      pending = Promise.reject(err);
    }
    attempt.promise = pending.then(settle, (err: unknown) => settle({
      ok: false,
      error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err), original: err },
    }));
    return attempt.promise;
  };

  return {
    ensure,
    cancel: (key, surfaceId) => {
      if (!inFlight.has(key)) return;
      inFlight.delete(key);
      bump(key);
      deps.setAttempt(key, null);
      if (surfaceId) deps.cancelCreate(surfaceId);
    },
    invalidateAll: () => {
      for (const key of [...inFlight.keys()]) {
        inFlight.delete(key);
        bump(key);
        deps.setAttempt(key, null);
      }
    },
    isInFlight: (key) => inFlight.has(key),
    isRefused: (key) => deps.getAttempt(key)?.state === 'createFailed',
    clearRefusal: (key) => {
      if (deps.getAttempt(key)?.state === 'createFailed') deps.setAttempt(key, null);
    },
  };
}

/** The app's lifecycle, bound to the store and the preload pty API. */
export const ptyLifecycle: PtyLifecycle = createPtyLifecycle({
  getAttempt: (key) => useStore.getState().ptyCreateByKey?.[key],
  setAttempt: (key, attempt) => useStore.getState().setPtyCreateAttempt?.(key, attempt),
  dispose: (ptyId) => window.electronAPI.pty.dispose(ptyId),
  // Optional-chain style guard, as at reportViewerVisibility: a packaged app
  // updated under a running renderer can leave a preload without the method.
  cancelCreate: (surfaceId) => {
    if (typeof window.electronAPI.pty.cancelCreate === 'function') void window.electronAPI.pty.cancelCreate(surfaceId);
  },
});
