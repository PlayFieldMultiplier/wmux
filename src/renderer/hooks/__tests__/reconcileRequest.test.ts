import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkspace, type PaneLeaf } from '../../../shared/types';

// Module state (the requester, a held request) is per renderer: each test
// starts from a fresh copy.
let awaitsReconcile: typeof import('../reconcileRequest').awaitsReconcile;
let requestReconcile: typeof import('../reconcileRequest').requestReconcile;
let setReconcileRequester: typeof import('../reconcileRequest').setReconcileRequester;
beforeEach(async () => {
  vi.resetModules();
  ({ awaitsReconcile, requestReconcile, setReconcileRequester } = await import('../reconcileRequest'));
});

describe('reconcileRequest (#2398)', () => {
  it('reports false when no requester was ever registered, and reaches the registered one', () => {
    expect(requestReconcile('x')).toBe(false);
    const fn = vi.fn();
    const off = setReconcileRequester(fn);
    expect(requestReconcile('pane a')).toBe(true);
    expect(fn).toHaveBeenCalledWith('pane a');
    off();
  });

  it('a request made while AppLayout remounts reaches the next requester (review P3)', () => {
    const first = vi.fn();
    setReconcileRequester(first)();
    // Unregistered (remount in progress): held, and the pane keeps its binding.
    expect(requestReconcile('pane b')).toBe(true);
    expect(requestReconcile('pane c')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    const next = vi.fn();
    setReconcileRequester(next);
    // One pass serves every held request.
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith('pane b');
  });

  it('an old unregister does not remove a newer requester', () => {
    const offOld = setReconcileRequester(vi.fn());
    const fresh = vi.fn();
    const offNew = setReconcileRequester(fresh);
    offOld();
    expect(requestReconcile('z')).toBe(true);
    expect(fresh).toHaveBeenCalledWith('z');
    offNew();
  });

  it('only an unconfirmed surface binding waits on a reconcile; the floating pane does not (Codex P2)', () => {
    const ws = createWorkspace('ws');
    (ws.rootPane as PaneLeaf).surfaces = [{ id: 's1', ptyId: 'pty-surface', title: 't', shell: 'pwsh', cwd: '' }];
    const state = { workspaces: [ws], ptyUnconfirmedById: { 'pty-surface': 1, 'pty-float': 2 } };
    expect(awaitsReconcile(state, 'pty-surface')).toBe(true);
    expect(awaitsReconcile(state, 'pty-float')).toBe(false);
    expect(awaitsReconcile({ ...state, ptyUnconfirmedById: {} }, 'pty-surface')).toBe(false);
  });
});
