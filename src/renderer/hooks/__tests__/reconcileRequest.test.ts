import { describe, it, expect, vi } from 'vitest';
import { requestReconcile, setReconcileRequester } from '../reconcileRequest';

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
});
