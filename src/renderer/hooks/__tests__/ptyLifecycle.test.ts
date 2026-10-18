import { describe, it, expect, vi } from 'vitest';
import { createPtyLifecycle, type PtyLifecycleDeps } from '../ptyLifecycle';
import type { IpcResult } from '../useIpc';
import type { PtyCreateAttempt } from '../../stores/slices/ptyLifecycleSlice';

type Created = { id: string };

/** A lifecycle over an in-memory attempt map, plus a create the test settles by hand. */
function harness() {
  const attempts = new Map<string, PtyCreateAttempt>();
  const deps: PtyLifecycleDeps = {
    getAttempt: (key) => attempts.get(key),
    setAttempt: (key, attempt) => { if (attempt) attempts.set(key, attempt); else attempts.delete(key); },
    dispose: vi.fn(),
    cancelCreate: vi.fn(),
    log: () => undefined,
  };
  const settles: ((result: IpcResult<Created>) => void)[] = [];
  const create = vi.fn(() => new Promise<IpcResult<Created>>((r) => { settles.push(r); }));
  return { lifecycle: createPtyLifecycle(deps), deps, attempts, create, settles };
}

const ok = (id: string): IpcResult<Created> => ({ ok: true, data: { id } });
const refused = (message: string): IpcResult<Created> => ({ ok: false, error: { code: 'RESOURCE_EXHAUSTED', message } });

describe('ptyLifecycle.ensure (#2398)', () => {
  it('calls create synchronously and marks the key creating', () => {
    const h = harness();
    void h.lifecycle.ensure('surf', { create: h.create, bind: () => true });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.attempts.get('surf')).toEqual({ state: 'creating' });
    expect(h.lifecycle.isInFlight('surf')).toBe(true);
  });

  it('concurrent ensures for one key create once, share the promise, and bind through the latest caller', async () => {
    const h = harness();
    const firstBind = vi.fn(() => true);
    const secondBind = vi.fn(() => true);
    const secondCreate = vi.fn();
    const a = h.lifecycle.ensure('surf', { create: h.create, bind: firstBind });
    const b = h.lifecycle.ensure('surf', { create: secondCreate, bind: secondBind });
    expect(b).toBe(a);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(secondCreate).not.toHaveBeenCalled();
    h.settles[0](ok('pty-1'));
    await expect(a).resolves.toEqual({ status: 'bound', ptyId: 'pty-1' });
    expect(firstBind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledWith({ id: 'pty-1' });
    expect(h.attempts.has('surf')).toBe(false);
    expect(h.lifecycle.isInFlight('surf')).toBe(false);
  });

  it('different keys do not share an attempt', () => {
    const h = harness();
    void h.lifecycle.ensure('a', { create: h.create, bind: () => true });
    void h.lifecycle.ensure('b', { create: h.create, bind: () => true });
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it('a close (stale token) disposes the late create and never binds it', async () => {
    const h = harness();
    const bind = vi.fn(() => true);
    const outcome = h.lifecycle.ensure('surf', { create: h.create, bind });
    h.lifecycle.cancel('surf', 'surf');
    expect(h.deps.cancelCreate).toHaveBeenCalledWith('surf');
    expect(h.attempts.has('surf')).toBe(false);
    h.settles[0](ok('pty-late'));
    await expect(outcome).resolves.toEqual({ status: 'stale' });
    expect(bind).not.toHaveBeenCalled();
    expect(h.deps.dispose).toHaveBeenCalledWith('pty-late');
  });

  it('a new attempt after a cancel is not confused with the stale one', async () => {
    const h = harness();
    const oldBind = vi.fn(() => true);
    const newBind = vi.fn(() => true);
    const stale = h.lifecycle.ensure('surf', { create: h.create, bind: oldBind });
    h.lifecycle.cancel('surf');
    const fresh = h.lifecycle.ensure('surf', { create: h.create, bind: newBind });
    expect(h.create).toHaveBeenCalledTimes(2);
    h.settles[1](ok('pty-new'));
    h.settles[0](ok('pty-old'));
    await expect(fresh).resolves.toEqual({ status: 'bound', ptyId: 'pty-new' });
    await expect(stale).resolves.toEqual({ status: 'stale' });
    expect(newBind).toHaveBeenCalledWith({ id: 'pty-new' });
    expect(oldBind).not.toHaveBeenCalled();
    expect(h.deps.dispose).toHaveBeenCalledWith('pty-old');
    expect(h.deps.dispose).not.toHaveBeenCalledWith('pty-new');
  });

  it('a stale refusal does not overwrite the state of the attempt that replaced it', async () => {
    const h = harness();
    void h.lifecycle.ensure('surf', { create: h.create, bind: () => true });
    h.lifecycle.cancel('surf');
    void h.lifecycle.ensure('surf', { create: h.create, bind: () => true });
    h.settles[0](refused('old refusal'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.attempts.get('surf')).toEqual({ state: 'creating' });
  });

  it('cancel with nothing in flight does nothing (no IPC)', () => {
    const h = harness();
    h.lifecycle.cancel('surf', 'surf');
    expect(h.deps.cancelCreate).not.toHaveBeenCalled();
  });

  it('an owner that no longer takes the pty has it disposed', async () => {
    const h = harness();
    const outcome = h.lifecycle.ensure('leaf', { create: h.create, bind: () => false });
    h.settles[0](ok('pty-orphan'));
    await expect(outcome).resolves.toEqual({ status: 'stale' });
    expect(h.deps.dispose).toHaveBeenCalledWith('pty-orphan');
  });

  it('a bind that throws disposes instead of leaking', async () => {
    const h = harness();
    const outcome = h.lifecycle.ensure('leaf', { create: h.create, bind: () => { throw new Error('boom'); } });
    h.settles[0](ok('pty-x'));
    await expect(outcome).resolves.toEqual({ status: 'stale' });
    expect(h.deps.dispose).toHaveBeenCalledWith('pty-x');
  });

  it('a refused create stays refused: later ensures do not fire it again', async () => {
    const h = harness();
    const outcome = h.lifecycle.ensure('surf', { create: h.create, bind: () => true });
    h.settles[0](refused('Session limit reached'));
    await expect(outcome).resolves.toEqual({ status: 'createFailed', error: 'Session limit reached' });
    expect(h.attempts.get('surf')).toEqual({ state: 'createFailed', error: 'Session limit reached' });
    expect(h.lifecycle.isRefused('surf')).toBe(true);

    // A remount, an effect re-run: nothing fires.
    await expect(h.lifecycle.ensure('surf', { create: h.create, bind: () => true }))
      .resolves.toEqual({ status: 'createFailed', error: 'Session limit reached' });
    expect(h.create).toHaveBeenCalledTimes(1);

    // Retry does.
    const retried = h.lifecycle.ensure('surf', { create: h.create, bind: () => true, retry: true });
    expect(h.create).toHaveBeenCalledTimes(2);
    h.settles[1](ok('pty-2'));
    await expect(retried).resolves.toEqual({ status: 'bound', ptyId: 'pty-2' });
    expect(h.attempts.has('surf')).toBe(false);
  });

  it('clearRefusal lets the next plain ensure create again', async () => {
    const h = harness();
    const outcome = h.lifecycle.ensure('leaf', { create: h.create, bind: () => true });
    h.settles[0](refused('nope'));
    await outcome;
    h.lifecycle.clearRefusal('leaf');
    expect(h.lifecycle.isRefused('leaf')).toBe(false);
    void h.lifecycle.ensure('leaf', { create: h.create, bind: () => true });
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it('a create that throws synchronously is a refusal, not an exception', async () => {
    const h = harness();
    const outcome = h.lifecycle.ensure('surf', { create: () => { throw new Error('preload missing'); }, bind: () => true });
    await expect(outcome).resolves.toEqual({ status: 'createFailed', error: 'preload missing' });
  });

  it('invalidateAll makes every attempt in flight stale', async () => {
    const h = harness();
    const a = h.lifecycle.ensure('a', { create: h.create, bind: () => true });
    const b = h.lifecycle.ensure('b', { create: h.create, bind: () => true });
    h.lifecycle.invalidateAll();
    h.settles[0](ok('pty-a'));
    h.settles[1](ok('pty-b'));
    await expect(a).resolves.toEqual({ status: 'stale' });
    await expect(b).resolves.toEqual({ status: 'stale' });
    expect(h.deps.dispose).toHaveBeenCalledTimes(2);
  });

  it('retry runs the refused request again, same create and bind (Codex P2)', async () => {
    const h = harness();
    const bind = vi.fn(() => true);
    const outcome = h.lifecycle.ensure('leaf', { create: h.create, bind });
    h.settles[0](refused('cap'));
    await outcome;
    expect(h.lifecycle.retry('leaf')).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(2);
    h.settles[1](ok('pty-r'));
    await Promise.resolve(); await Promise.resolve();
    expect(bind).toHaveBeenCalledWith({ id: 'pty-r' });
    // Nothing held any more: a second retry only clears.
    expect(h.lifecycle.retry('leaf')).toBe(false);
  });

  it('retry with no refused request held only clears the refusal', () => {
    const h = harness();
    h.attempts.set('leaf', { state: 'createFailed', error: 'old' });
    expect(h.lifecycle.retry('leaf')).toBe(false);
    expect(h.attempts.has('leaf')).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });
});
