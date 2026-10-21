// @vitest-environment jsdom
//
// #2398 — a hidden pane still reattaches its live session, but leaves a
// suspended one (cap-skipped, or a WSL placeholder) suspended: promoting it
// is a spawn per hidden pane at boot. The pane promotes it exactly once, when
// it is first shown, or when a raw terminal write reaches it.
// Mounts the REAL useTerminal against a real xterm under jsdom (as
// useTerminal.hiddenGeometry.test.tsx).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { useStore } from '../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

type ReconnectAnswer = { success: boolean; deferred?: boolean; recoveryPending?: boolean; transient?: boolean; error?: string; resumeAgent?: string; resumeBinding?: { agent: string; sessionId: string; cwd: string } };
const reconnect = vi.fn<(id: string, opts?: { promote?: boolean }) => Promise<ReconnectAnswer>>(async () => ({ success: true }));
const unsub = () => () => undefined;
// The pane's own triggers, fired by hand: a supervised restart, its Retry.
let restarted: ((payload: { ptyId: string; restartCount: number; exitCode: number | null }) => void) | null = null;
let retryConnection: (() => Promise<void> | undefined) | null = null;

beforeAll(() => {
  installCanvas2dStub();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub,
        onRestarted: (cb: typeof restarted) => { restarted = cb; return () => undefined; },
        resize: vi.fn(async () => undefined), reconnect,
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: unsub },
      shell: { openPath: vi.fn(async () => ({ ok: true })) },
    },
  });
  Object.defineProperty(window, 'clipboardAPI', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => '') },
  });
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  reconnect.mockReset();
  reconnect.mockImplementation(async () => ({ success: true }));
  setDaemonModeActive(false);
  useStore.setState({ ptyDeferredById: {}, claudeResumeOnStart: false });
});

const settle = () => act(async () => { await deliberateSleep(50, 'lets the reattach settle under act; nothing polled'); });

type UseTerminal = typeof import('../useTerminal').useTerminal;
/** One component type for the whole test, so a later render() re-renders the
 *  same mounted terminal (shown/hidden) instead of remounting it. */
function Harness({ useTerminal, ptyId, surfaceShown }: { useTerminal: UseTerminal; ptyId: string; surfaceShown: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  retryConnection = useTerminal(ref, { ptyId, isVisible: surfaceShown, surfaceShown }).retryConnection;
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}

async function render(ptyId: string, surfaceShown: boolean): Promise<void> {
  const { useTerminal } = await import('../useTerminal');
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const r = root;
  await act(async () => { r.render(<Harness useTerminal={useTerminal} ptyId={ptyId} surfaceShown={surfaceShown} />); });
  await settle();
}

const promoteFlags = () => reconnect.mock.calls.map(([, opts]) => opts?.promote);

describe('reattach of a hidden pane (#2398)', { timeout: 60_000 }, () => {
  it('a hidden live session still reattaches (without promote) and is not deferred', async () => {
    setDaemonModeActive(true);
    await render('p-live', false);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-live']).toBeUndefined();
  });

  it('a hidden suspended session is neither promoted nor cleared, and is promoted exactly once on first show', async () => {
    reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true } : { success: true }));
    setDaemonModeActive(true);
    await render('p-suspended', false);
    // Answered deferred: one call, no back-off retries (the first slot is 400 ms).
    await act(async () => { await deliberateSleep(700, 'longer than the first reconnect back-off slot; asserts no retry happened'); });
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-suspended']).toBe(true);

    await render('p-suspended', true);
    expect(promoteFlags()).toEqual([false, true]);
    expect(useStore.getState().ptyDeferredById['p-suspended']).toBeUndefined();

    // Hidden and shown again: attached already, nothing more.
    await render('p-suspended', false);
    await render('p-suspended', true);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it('a raw write to a hidden suspended session promotes it through the pane', async () => {
    reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true } : { success: true }));
    setDaemonModeActive(true);
    await render('p-written', false);
    const { attachForWrite } = await import('../useTerminal');
    let started: string | undefined;
    await act(async () => { started = await attachForWrite('p-written'); });
    expect(started).toBe('attached');
    expect(promoteFlags()).toEqual([false, true]);
    expect(useStore.getState().ptyDeferredById['p-written']).toBeUndefined();
  });

  // Re-review P2: a stop key reaches a mounted pane's session through the
  // pane's own reattach, without promoting: a suspended one stays suspended.
  it('a stop key to a hidden suspended session reattaches without promoting it', async () => {
    reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true } : { success: true }));
    setDaemonModeActive(true);
    await render('p-stop', false);
    const { attachForWrite } = await import('../useTerminal');
    let answer: string | undefined;
    await act(async () => { answer = await attachForWrite('p-stop', false); });
    // Known held: no second reconnect, answered not running.
    expect(promoteFlags()).toEqual([false]);
    expect(answer).toBe('not-running');
    expect(useStore.getState().ptyDeferredById['p-stop']).toBe(true);
  });

  // Re-review P2: the stop key's attempt took the pane's own promote rule, so
  // on a SHOWN pane it reconnected with promote — a commander's ctrl+c could
  // start a session.
  it('a stop key on a shown pane reattaches without promoting', async () => {
    setDaemonModeActive(true);
    await render('p-shown-stop', true);
    expect(promoteFlags()).toEqual([true]);
    const { attachForWrite } = await import('../useTerminal');
    let answer: string | undefined;
    await act(async () => { answer = await attachForWrite('p-shown-stop', false); });
    expect(promoteFlags()).toEqual([true, false]);
    expect(answer).toBe('attached');
  });

  // Re-review P2 scenario: a shown WSL pane whose recovery failed waits for its
  // Retry; a stop key acted as that Retry click and started the distro.
  it('a stop key on a shown pane waiting for its recovery Retry answers not running and starts nothing', async () => {
    reconnect.mockImplementation(async () => ({ success: false, recoveryPending: true, error: 'WSL recovery failed' } as ReconnectAnswer));
    setDaemonModeActive(true);
    await render('p-retry', true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    const { attachForWrite } = await import('../useTerminal');
    let answer: string | undefined;
    await act(async () => { answer = await attachForWrite('p-retry', false); });
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(answer).toBe('not-running');
  });

  // Re-review P3: a stop key whose attach finds the session suspended must not
  // be what arms resume on start either.
  it('a stop key that finds the session suspended arms no resume on start', async () => {
    useStore.setState({ claudeResumeOnStart: true });
    const exact = { agent: 'claude', sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/p' };
    setDaemonModeActive(true);
    await render('p-stop-resume', false);
    expect(promoteFlags()).toEqual([false]);
    reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true, resumeBinding: exact } : { success: true }));
    const { attachForWrite } = await import('../useTerminal');
    let answer: string | undefined;
    await act(async () => { answer = await attachForWrite('p-stop-resume', false); });
    await settle();
    expect(promoteFlags()).toEqual([false, false]);
    expect(answer).toBe('not-running');
  });

  // Review item 6 — a read (pane.search, input.readScreen, an approval probe)
  // hydrates a dirty pane through a resync reconnect, which asked for no
  // promote flag and so promoted: reading a hidden pane started its session.
  it('a read of a hidden suspended session neither hydrates nor reconnects it', async () => {
    reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true } : { success: true }));
    setDaemonModeActive(true);
    await render('p-read', false);
    expect(useStore.getState().ptyDeferredById['p-read']).toBe(true);
    const { hydrateTerminalForRead, terminalRegistry } = await import('../useTerminal');
    const { markTerminalDirty } = await import('../../terminal/terminalOutputScheduler');
    const terminal = terminalRegistry.get('p-read');
    expect(terminal).toBeDefined();
    markTerminalDirty(terminal as never);
    let hydrated = true;
    await act(async () => { hydrated = await hydrateTerminalForRead('p-read'); });
    await settle();
    expect(hydrated).toBe(false);
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-read']).toBe(true);
  });
});

// #2398 §6-4 option B: before #2398 every pane started at boot, so
// resume-on-start also brought back the agents of hidden suspended panes
// (WSL placeholders, sessions past the restore limit). A suspended session
// whose record binds an exact Claude Code / Codex conversation is still
// promoted at boot while hidden when the setting is on; anything else waits
// for the pane's first show.
// Re-review P2: a stop key's attempt does not apply the pane's own rules, and
// the pane's triggers that arrive while it is in flight are folded into it.
// Its settle must apply them: a pane shown during it, or whose own trigger
// (a restart, a retry timer) was folded in, is not left suspended.
describe('the pane\'s own rules after a stop key\'s attempt (#2398)', { timeout: 60_000 }, () => {
  const exact = { agent: 'claude', sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/p' };

  /** Live at mount; then a stop key's attach (promote:false) that waits for release() and finds it suspended. */
  async function stopKeyInFlight(ptyId: string, extra: Partial<ReconnectAnswer> = {}) {
    setDaemonModeActive(true);
    await render(ptyId, false);
    expect(promoteFlags()).toEqual([false]);
    let release: () => void = () => undefined;
    reconnect.mockImplementation(async (_id, opts) => {
      if (opts?.promote !== false) return { success: true };
      await new Promise<void>((r) => { release = r; });
      return { success: false, deferred: true, ...extra };
    });
    const { attachForWrite } = await import('../useTerminal');
    const result: { answer?: string } = {};
    let pending: Promise<void> = Promise.resolve();
    await act(async () => { pending = attachForWrite(ptyId, false).then((a) => { result.answer = a; }); });
    const settleIt = async () => {
      // Only the first held attach waits; anything after answers at once.
      reconnect.mockImplementation(async (_id, opts) => (opts?.promote === false ? { success: false, deferred: true, ...extra } : { success: true }));
      await act(async () => { release(); await pending; });
      await settle();
    };
    return { result, settleIt };
  }

  it('a pane shown while it is in flight is promoted exactly once when it settles suspended', async () => {
    const { result, settleIt } = await stopKeyInFlight('p-shown-mid');
    await render('p-shown-mid', true);
    await settleIt();
    expect(promoteFlags()).toEqual([false, false, true]);
    expect(result.answer).toBe('not-running');
    expect(useStore.getState().ptyDeferredById['p-shown-mid']).toBeUndefined();
  });

  it('a pane that stays hidden is not promoted: the key still starts nothing', async () => {
    useStore.setState({ claudeResumeOnStart: true });
    const { result, settleIt } = await stopKeyInFlight('p-hidden-mid', { resumeBinding: exact });
    await settleIt();
    expect(promoteFlags()).toEqual([false, false]);
    expect(result.answer).toBe('not-running');
    expect(useStore.getState().ptyDeferredById['p-hidden-mid']).toBe(true);
  });

  it("a hidden pane's own trigger folded into it still resumes its agent on start", async () => {
    useStore.setState({ claudeResumeOnStart: true });
    const { settleIt } = await stopKeyInFlight('p-folded', { resumeBinding: exact });
    // A supervised restart arrives mid-attempt: dropped as a reattach of its own.
    act(() => { restarted?.({ ptyId: 'p-folded', restartCount: 1, exitCode: 0 }); });
    await settleIt();
    expect(promoteFlags()).toEqual([false, false, true]);
  });
});

// Re-review P3: Start fresh promotes, then asks the pane to retry. A retry that
// arrived while another attempt was in flight was dropped, and that attempt
// settled on the recovery failure it began with: the pane kept answering stop
// keys "not running" over a live session.
describe('a Retry during an attempt in flight (#2398)', { timeout: 60_000 }, () => {
  it('runs after it instead of being dropped', async () => {
    reconnect.mockImplementation(async () => ({ success: false, recoveryPending: true, error: 'WSL recovery failed' }));
    setDaemonModeActive(true);
    await render('p-fresh', true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    let release: () => void = () => undefined;
    reconnect.mockImplementation(async () => {
      await new Promise<void>((r) => { release = r; });
      return { success: false, recoveryPending: true, error: 'WSL recovery failed' };
    });
    // Another attempt is in flight (a supervised restart) when Start fresh lands.
    act(() => { restarted?.({ ptyId: 'p-fresh', restartCount: 1, exitCode: 0 }); });
    expect(reconnect).toHaveBeenCalledTimes(2);
    let retried: Promise<void> | undefined;
    act(() => { retried = retryConnection?.(); });
    reconnect.mockImplementation(async () => ({ success: true }));
    await act(async () => { release(); await retried; });
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(3);
    const { attachForWrite } = await import('../useTerminal');
    let answer: string | undefined;
    await act(async () => { answer = await attachForWrite('p-fresh', false); });
    expect(answer).toBe('attached');
  });
});

describe('resume on start for a hidden suspended session (#2398 §6-4 option B)', { timeout: 60_000 }, () => {
  const exact = { agent: 'claude', sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/p' };
  const suspendedWith = (extra: Partial<ReconnectAnswer>) => async (_id: string, opts?: { promote?: boolean }): Promise<ReconnectAnswer> =>
    (opts?.promote === false ? { success: false, deferred: true, ...extra } : { success: true });

  it('setting on: promoted at boot while hidden', async () => {
    useStore.setState({ claudeResumeOnStart: true });
    reconnect.mockImplementation(suspendedWith({ resumeBinding: exact }));
    setDaemonModeActive(true);
    await render('p-agent-on', false);
    expect(promoteFlags()).toEqual([false, true]);
    expect(useStore.getState().ptyDeferredById['p-agent-on']).toBeUndefined();
  });

  it('setting off: stays deferred until first show', async () => {
    reconnect.mockImplementation(suspendedWith({ resumeBinding: exact }));
    setDaemonModeActive(true);
    await render('p-agent-off', false);
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-agent-off']).toBe(true);
    await render('p-agent-off', true);
    expect(promoteFlags()).toEqual([false, true]);
  });

  it('a plain shell with the setting on stays deferred', async () => {
    useStore.setState({ claudeResumeOnStart: true });
    reconnect.mockImplementation(suspendedWith({}));
    setDaemonModeActive(true);
    await render('p-plain', false);
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-plain']).toBe(true);
  });

  it('a binding without an exact session id stays deferred', async () => {
    useStore.setState({ claudeResumeOnStart: true });
    reconnect.mockImplementation(suspendedWith({ resumeAgent: 'claude', resumeBinding: { ...exact, sessionId: 'latest' } }));
    setDaemonModeActive(true);
    await render('p-guess', false);
    expect(promoteFlags()).toEqual([false]);
    expect(useStore.getState().ptyDeferredById['p-guess']).toBe(true);
  });
});
