import { describe, it, expect, vi } from 'vitest';
import { awaitsReconcile, requestReconcile, setReconcileRequester } from '../reconcileRequest';
import { createWorkspace, type PaneLeaf } from '../../../shared/types';

describe('reconcileRequest (#2398)', () => {
  it('reports false with no requester, and reaches the registered one', () => {
    expect(requestReconcile('x')).toBe(false);
    const fn = vi.fn();
    const off = setReconcileRequester(fn);
    expect(requestReconcile('pane a')).toBe(true);
    expect(fn).toHaveBeenCalledWith('pane a');
    off();
    expect(requestReconcile('y')).toBe(false);
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
    const state = { workspaces: [ws], ptyUnconfirmedById: { 'pty-surface': true as const, 'pty-float': true as const } };
    expect(awaitsReconcile(state, 'pty-surface')).toBe(true);
    expect(awaitsReconcile(state, 'pty-float')).toBe(false);
    expect(awaitsReconcile({ ...state, ptyUnconfirmedById: {} }, 'pty-surface')).toBe(false);
  });
});
