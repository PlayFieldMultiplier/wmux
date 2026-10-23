import { describe, it, expect, vi } from 'vitest';
import { loadSessionThenDaemonDecision } from '../startupDaemonDecision';

// The pane gate opens once this settles (AppLayout's startup restore). A first
// launch's first pane created before main's daemon-or-local decision was a
// local PTY: the packaged first run's terminal never became a daemon session.

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('loadSessionThenDaemonDecision', () => {
  it('a first launch, with nothing saved, does not settle before main has decided daemon or local', async () => {
    const decision = deferred<{ connected: boolean }>();
    const order: string[] = [];
    let settled = false;
    const run = loadSessionThenDaemonDecision<{ v: 1 }>({
      load: async () => null,
      nothingSaved: () => order.push('nothing saved'),
      restore: () => order.push('restore'),
      whenReady: () => decision.promise,
      setDaemonModeActive: (c) => order.push(`daemon mode ${c}`),
    }).then((r) => { settled = true; return r; });
    await flush();
    // The daemon connects late: the gate must still be shut.
    expect(settled).toBe(false);
    expect(order).toEqual(['nothing saved']);
    decision.resolve({ connected: true });
    expect(await run).toEqual({ saved: null, daemonConnected: true });
    expect(order).toEqual(['nothing saved', 'daemon mode true']);
  });

  it('a saved session is restored before the wait, and the mode is set before it settles', async () => {
    const decision = deferred<{ connected: boolean }>();
    const order: string[] = [];
    const run = loadSessionThenDaemonDecision({
      load: async () => ({ workspaces: ['a'] }),
      nothingSaved: () => order.push('nothing saved'),
      restore: (saved) => order.push(`restore ${saved.workspaces.join(',')}`),
      whenReady: () => decision.promise,
      setDaemonModeActive: (c) => order.push(`daemon mode ${c}`),
    });
    await flush();
    expect(order).toEqual(['restore a']);
    decision.resolve({ connected: false });
    expect(await run).toEqual({ saved: { workspaces: ['a'] }, daemonConnected: false });
    expect(order).toEqual(['restore a', 'daemon mode false']);
  });

  it('a failed load or decision rejects, so the caller still opens the gate in its finally', async () => {
    const setMode = vi.fn();
    await expect(loadSessionThenDaemonDecision({ load: async () => { throw new Error('load'); }, nothingSaved: vi.fn(), restore: vi.fn(), whenReady: async () => ({ connected: true }), setDaemonModeActive: setMode })).rejects.toThrow('load');
    await expect(loadSessionThenDaemonDecision({ load: async () => undefined, nothingSaved: vi.fn(), restore: vi.fn(), whenReady: async () => { throw new Error('ready'); }, setDaemonModeActive: setMode })).rejects.toThrow('ready');
    expect(setMode).not.toHaveBeenCalled();
  });
});
