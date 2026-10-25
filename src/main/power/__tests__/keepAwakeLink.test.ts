// The daemon half of "Keep the computer awake": a paired phone the daemon
// reports attached holds the blocker in 'working' mode, and main reports its
// mode and blocker back. The blocker and the daemon client are fakes.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeepAwakeLink, type KeepAwakeClient } from '../keepAwakeLink';
import { RELEASE_GRACE_MS, SleepPrevention, type PowerSaveBlockerLike } from '../sleepPrevention';

function fakeBlocker(): PowerSaveBlockerLike & { started: Set<number> } {
  const started = new Set<number>();
  let next = 1;
  return {
    started,
    start: () => { const id = next++; started.add(id); return id; },
    stop: (id) => { started.delete(id); },
    isStarted: (id) => started.has(id),
  };
}

function fakeClient() {
  const emitter = new EventEmitter();
  const rpc = vi.fn(async () => ({ ok: true }));
  const client = Object.assign(emitter, { rpc }) as unknown as KeepAwakeClient & EventEmitter;
  const presence = (attached: unknown) => emitter.emit('event', { type: 'phone.presence', sessionId: '', data: { attached } });
  return { client, rpc, presence };
}

describe('installKeepAwakeLink', () => {
  let blocker: ReturnType<typeof fakeBlocker>;
  let sp: SleepPrevention;

  beforeEach(() => {
    vi.useFakeTimers();
    blocker = fakeBlocker();
    sp = new SleepPrevention({ blocker });
  });
  afterEach(() => {
    sp.dispose();
    vi.useRealTimers();
  });

  it('a phone link opening holds the blocker with no agent working; its end releases it after the grace', () => {
    const { client, presence } = fakeClient();
    installKeepAwakeLink(client, sp);
    expect(sp.heldId).toBeNull();
    presence(true);
    expect(sp.heldId).not.toBeNull();
    presence(false);
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(sp.heldId).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(sp.heldId).toBeNull();
  });

  it('only a true `attached` counts', () => {
    const { client, presence } = fakeClient();
    installKeepAwakeLink(client, sp);
    presence('yes');
    presence(1);
    expect(sp.heldId).toBeNull();
  });

  it('a daemon disconnect clears "attached" in main', () => {
    const { client, presence } = fakeClient();
    installKeepAwakeLink(client, sp);
    presence(true);
    client.emit('disconnected');
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(sp.heldId).toBeNull();
  });

  it('tearing the link down (the daemon was swapped out) clears it too, and stops listening', () => {
    const { client, presence } = fakeClient();
    const dispose = installKeepAwakeLink(client, sp);
    presence(true);
    dispose();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(sp.heldId).toBeNull();
    presence(true);
    expect(sp.heldId).toBeNull();
  });

  it('reports mode and blocker to the daemon at install, on each change, and after each presence report', () => {
    const { client, rpc, presence } = fakeClient();
    installKeepAwakeLink(client, sp);
    expect(rpc).toHaveBeenLastCalledWith('daemon.phone.keepAwake', { mode: 'working', active: false });
    rpc.mockClear();
    presence(false); // the resync right after register: the daemon gets the state again
    expect(rpc.mock.calls).toEqual([['daemon.phone.keepAwake', { mode: 'working', active: false }]]);
    rpc.mockClear();
    sp.setMode('always');
    expect(rpc.mock.calls).toEqual([['daemon.phone.keepAwake', { mode: 'always', active: true }]]);
  });

  it('a daemon that does not know the method is not an error', async () => {
    const { client, rpc } = fakeClient();
    rpc.mockRejectedValue(new Error('Unknown method'));
    expect(() => installKeepAwakeLink(client, sp)).not.toThrow();
    await Promise.resolve();
  });
});
