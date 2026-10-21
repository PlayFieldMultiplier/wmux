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

type ReconnectAnswer = { success: boolean; deferred?: boolean; transient?: boolean; error?: string; resumeAgent?: string; resumeBinding?: { agent: string; sessionId: string; cwd: string } };
const reconnect = vi.fn<(id: string, opts?: { promote?: boolean }) => Promise<ReconnectAnswer>>(async () => ({ success: true }));
const unsub = () => () => undefined;

beforeAll(() => {
  installCanvas2dStub();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
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

async function render(ptyId: string, surfaceShown: boolean): Promise<void> {
  const { useTerminal } = await import('../useTerminal');
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: surfaceShown, surfaceShown });
    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
  }
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const r = root;
  await act(async () => { r.render(<Harness />); });
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
    let started = false;
    await act(async () => { started = await attachForWrite('p-written'); });
    expect(started).toBe(true);
    expect(promoteFlags()).toEqual([false, true]);
    expect(useStore.getState().ptyDeferredById['p-written']).toBeUndefined();
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
