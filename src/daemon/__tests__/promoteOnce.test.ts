import { describe, it, expect, vi } from 'vitest';
import { createPromoteOnce, type PromoteResult } from '../promoteOnce';

/** A promoteSession whose attempts settle when the test says. */
function controlled() {
  const settles: Array<(r: PromoteResult) => void> = [];
  const promoteSession = vi.fn((params: { id: string; fresh: boolean }) => new Promise<PromoteResult>((r) => { void params; settles.push(r); }));
  return { promoteSession, settle: (i: number, r: PromoteResult) => settles[i](r) };
}

// #2398 round 7 — only the daemon knows whether a promote call started the
// session or joined an attempt already in flight (the boot background start
// of an exec unit, or another caller's). A stop key must never land in a
// session its own call just started, and must reach one it did not start.
describe('promoteOnce', () => {
  it('a call with nothing in flight starts the session and is not marked joined', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const first = promoteOnce('s1');
    settle(0, { ok: true, alreadyActive: false });
    expect(await first).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession).toHaveBeenCalledTimes(1);
  });

  it('a second call while the first is in flight joins it and is told so', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const background = promoteOnce('s1');
    const caller = promoteOnce('s1');
    settle(0, { ok: true, alreadyActive: false });
    expect(await background).toEqual({ ok: true, alreadyActive: false });
    expect(await caller).toEqual({ ok: true, alreadyActive: false, joined: true });
    expect(promoteSession).toHaveBeenCalledTimes(1);
  });

  it('a call after a failed attempt settled starts its own (nothing to join)', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const background = promoteOnce('s1');
    settle(0, { ok: false, error: { code: 'SPAWN_FAILED', message: 'distro busy' } });
    await background;
    const caller = promoteOnce('s1');
    settle(1, { ok: true, alreadyActive: false });
    expect(await caller).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession).toHaveBeenCalledTimes(2);
  });

  it('a start-fresh queued behind an ordinary promote runs its own attempt', async () => {
    const { promoteSession, settle } = controlled();
    const promoteOnce = createPromoteOnce(promoteSession);
    const ordinary = promoteOnce('s1');
    const fresh = promoteOnce('s1', true);
    settle(0, { ok: false, error: { code: 'CWD_MISSING', message: 'gone' } });
    await ordinary;
    await vi.waitFor(() => expect(promoteSession).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    settle(1, { ok: true, alreadyActive: false });
    expect(await fresh).toEqual({ ok: true, alreadyActive: false });
    expect(promoteSession.mock.calls[1][0]).toEqual({ id: 's1', fresh: true });
  });
});
