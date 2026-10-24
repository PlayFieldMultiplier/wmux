// Drops go to the mirror shown in the surface that was dropped on: two views
// of one remote session each keep their own registration.
import { describe, expect, it, vi } from 'vitest';
import { deliverMirrorDrop, registerMirrorDropTarget } from '../mirrorFileSend';

describe('mirror drop targets', () => {
  it('are kept per surface, and one view going away leaves the other', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerMirrorDropTarget('surface-a', a);
    const offB = registerMirrorDropTarget('surface-b', b);
    const registerDrop = async () => 'token';
    expect(deliverMirrorDrop('surface-b', registerDrop)).toBe(true);
    expect(b).toHaveBeenCalledWith(registerDrop);
    expect(a).not.toHaveBeenCalled();
    offA();
    expect(deliverMirrorDrop('surface-b', registerDrop)).toBe(true);
    expect(deliverMirrorDrop('surface-a', registerDrop)).toBe(false);
    offB();
    expect(deliverMirrorDrop('surface-b', registerDrop)).toBe(false);
  });
});
