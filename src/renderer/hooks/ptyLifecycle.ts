/**
 * #2398 — one create path for the ptys that blank surfaces start themselves.
 *
 * `ensure(key, request)` keeps at most one create in flight per key (a
 * surface id, or a leaf id for the empty-leaf funnel). A second call for the
 * same key joins the attempt already running instead of starting another, and
 * the latest caller's `bind` is the one used, so a Terminal that remounts
 * mid-create (a split, a moved tab) binds through its new instance.
 *
 * Only a close or a replace ends an attempt early: `cancel(key)` drops the
 * key's attempt (the attempt object is its token) and asks main to drop the
 * pending create. A visibility change, an effect re-run or a remount never
 * does. A create that settles once its attempt is no longer the key's, or
 * whose owner no longer takes it (`bind` returns false), is disposed and
 * never bound.
 *
 * A refused create leaves the key `createFailed` and never re-fires by
 * itself: only an `ensure` with `retry` (the pane's Retry) starts it again.
 * A key whose owner is gone keeps nothing: `cancel` forgets it whether or not
 * a create is in flight, and `releaseOrphans` forgets the refusal of a
 * surface or leaf that closed without one.
 *
 * The state mirror lives in the store (ptyLifecycleSlice); the promises and
 * tokens live here, since neither belongs in a serializable store. Pure
 * factory with injected deps, so the policy is unit-testable without a store
 * or Electron (as reconnectPtyWithRetry.ts).
 */
import { useEffect } from 'react';
import type { IpcResult } from './useIpc';
import type { PtyCreateAttempt } from '../stores/slices/ptyLifecycleSlice';
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';

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
  /**
   * Whether the key's owner (its surface or leaf) still exists. A refusal is
   * kept only for an owner that can show it; absent = it always does.
   */
  ownerExists?: (key: string) => boolean;
  log?: (message: string, err?: unknown) => void;
}

export interface PtyLifecycle {
  ensure: <T extends PtyCreated>(key: string, request: PtyEnsureRequest<T>) => Promise<PtyEnsureOutcome>;
  /**
   * Close or replace: end the key's attempt (if any), so its create is never
   * bound, and forget the key's refusal.
   */
  cancel: (key: string, surfaceId?: string) => void;
  /** A store-wide clear: every attempt in flight is stale. */
  invalidateAll: () => void;
  isInFlight: (key: string) => boolean;
  isRefused: (key: string) => boolean;
  /** Forget a refusal so the next ensure (the funnel's re-run) creates again. */
  clearRefusal: (key: string) => void;
  /**
   * The pane's Retry for a refused key: run the refused request again, with
   * the same options (a project pane's seeded command and directory were
   * consumed by the first attempt and exist nowhere else). False when no
   * refused request is held; the refusal is then just cleared.
   */
  retry: (key: string) => boolean;
  /** Forget the refusals whose owner is gone (see ownerExists). */
  releaseOrphans: () => void;
}

interface Attempt {
  bind: (created: PtyCreated) => boolean;
  promise: Promise<PtyEnsureOutcome>;
}

export function createPtyLifecycle(deps: PtyLifecycleDeps): PtyLifecycle {
  const inFlight = new Map<string, Attempt>();
  /** The request behind each key's current refusal, for an explicit retry. */
  const refused = new Map<string, PtyEnsureRequest<PtyCreated>>();
  const log = deps.log ?? ((message: string, err?: unknown) => {
    // eslint-disable-next-line no-console
    if (err === undefined) console.warn(message); else console.warn(message, err);
  });
  const ownerExists = deps.ownerExists ?? (() => true);

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
    refused.delete(key);
    const attempt = { bind: request.bind as (created: PtyCreated) => boolean } as Attempt;
    inFlight.set(key, attempt);
    deps.setAttempt(key, { state: 'creating' });

    const settle = (result: IpcResult<T>): PtyEnsureOutcome => {
      // Current while no close, replace or newer attempt has taken the key.
      const current = inFlight.get(key) === attempt;
      if (current) inFlight.delete(key);
      if (!result.ok) {
        // The refusal belongs to this key only while no newer attempt replaced
        // it, and is kept only while its owner is there to show it.
        if (current && ownerExists(key)) {
          deps.setAttempt(key, { state: 'createFailed', error: result.error.message });
          refused.set(key, { create: request.create, bind: attempt.bind } as PtyEnsureRequest<PtyCreated>);
        } else if (current) {
          deps.setAttempt(key, null);
        }
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
      refused.delete(key);
      deps.setAttempt(key, null);
      if (!inFlight.delete(key)) return;
      if (surfaceId) deps.cancelCreate(surfaceId);
    },
    invalidateAll: () => {
      for (const key of [...inFlight.keys()]) {
        inFlight.delete(key);
        deps.setAttempt(key, null);
      }
    },
    isInFlight: (key) => inFlight.has(key),
    isRefused: (key) => deps.getAttempt(key)?.state === 'createFailed',
    clearRefusal: (key) => {
      refused.delete(key);
      if (deps.getAttempt(key)?.state === 'createFailed') deps.setAttempt(key, null);
    },
    retry: (key) => {
      const request = refused.get(key);
      if (!request || deps.getAttempt(key)?.state !== 'createFailed') {
        refused.delete(key);
        if (deps.getAttempt(key)?.state === 'createFailed') deps.setAttempt(key, null);
        return false;
      }
      void ensure(key, { ...request, retry: true });
      return true;
    },
    releaseOrphans: () => {
      for (const key of [...refused.keys()]) {
        if (inFlight.has(key) || ownerExists(key)) continue;
        refused.delete(key);
        if (deps.getAttempt(key)?.state === 'createFailed') deps.setAttempt(key, null);
      }
    },
  };
}

/**
 * The key a Terminal with no surface creates under (Terminal.tsx). Its owner
 * is that component instance, which cancels the key when it unmounts.
 */
export const TERMINAL_INSTANCE_KEY_PREFIX = 'terminal-instance:';

/** Whether a workspace still holds a surface or a leaf (a stashed one too) with this id. */
function workspacesHoldKey(key: string): boolean {
  for (const ws of useStore.getState().workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      if (leaf.id === key || leaf.surfaces.some((s) => s.id === key)) return true;
    }
  }
  return false;
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
  ownerExists: (key) => key.startsWith(TERMINAL_INSTANCE_KEY_PREFIX) || workspacesHoldKey(key),
});

/**
 * A closed leaf has no Terminal whose unmount could forget its refusal, and a
 * surface can close while its pane is not drawn: while mounted (the empty-leaf
 * funnel, for the app's life), forget the refusals whose owner has left the
 * workspaces.
 */
export function useReleaseOrphanedRefusals(): void {
  useEffect(() => useStore.subscribe((state, prev) => {
    if (state.workspaces !== prev.workspaces) ptyLifecycle.releaseOrphans();
  }), []);
}

/**
 * A key refused before, whose owner another path has since filled (a leaf
 * that got a tab through Ctrl+T, say), is no longer refused: when it empties
 * again it must create, not show the old failure. Runs where the owner is
 * drawn (the empty-leaf funnel only sees empty leaves).
 */
export function useClearRefusalWhenFilled(key: string, filled: boolean, refused: boolean): void {
  useEffect(() => {
    if (filled && refused) ptyLifecycle.clearRefusal(key);
  }, [key, filled, refused]);
}
