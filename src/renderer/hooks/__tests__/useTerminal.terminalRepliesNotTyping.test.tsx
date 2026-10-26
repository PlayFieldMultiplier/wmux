// @vitest-environment jsdom
//
// xterm answers a program's terminal queries (DA1, cursor position, kitty
// keyboard flags) through the same onData as the user's keys. The answer must
// still reach the PTY, but it is not the user typing: it must not retract the
// pane's resume hint, which a pane nobody is looking at would otherwise lose
// to any program that merely asks. Mounts the REAL useTerminal against a real
// xterm under jsdom (as useTerminal.hiddenGeometry.test.tsx).

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef, type MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { createRoot, type Root } from 'react-dom/client';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { useStore } from '../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

// eslint-disable-next-line no-control-regex
const DA1_REPLY = /^\x1b\[\?[\d;]*c$/;
// eslint-disable-next-line no-control-regex
const CPR_REPLY = /^\x1b\[\d+;\d+R$/;
// eslint-disable-next-line no-control-regex
const KITTY_FLAGS_REPLY = /^\x1b\[\?\d+u$/;

const write = vi.fn<(id: string, data: string) => Promise<void>>(async () => undefined);
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
        resize: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => ({ success: true })),
        setViewerVisibility: vi.fn(),
        write,
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
let termRef: MutableRefObject<Terminal | null> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  termRef = null;
  write.mockClear();
  setDaemonModeActive(false);
  useStore.setState({ resumeHintByPtyId: {} });
});

async function mount(ptyId: string): Promise<Terminal> {
  const { useTerminal } = await import('../useTerminal');
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    termRef = useTerminal(ref, { ptyId, isVisible: false }).terminal;
    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  root = r;
  setDaemonModeActive(true);
  await act(async () => { r.render(<Harness />); });
  await act(async () => { await deliberateSleep(50, 'lets the mount and reattach settle under act; nothing polled'); });
  const term = termRef?.current;
  if (!term) throw new Error('useTerminal created no terminal');
  return term;
}

const output = (term: Terminal, data: string) => act(async () => {
  await new Promise<void>((resolve) => term.write(data, resolve));
});
const written = (ptyId: string) => write.mock.calls.filter(([id]) => id === ptyId).map(([, d]) => d);

describe('terminal replies are not the user typing', { timeout: 60_000 }, () => {
  it('a DA1, cursor-position or kitty-flags reply reaches the PTY but keeps the resume hint', async () => {
    const term = await mount('p-query');
    useStore.getState().setResumeHint('p-query', 'claude');
    write.mockClear();

    await output(term, '\x1b[c\x1b[6n\x1b[?u');

    const replies = written('p-query');
    expect(replies.some((d) => DA1_REPLY.test(d))).toBe(true);
    expect(replies.some((d) => CPR_REPLY.test(d))).toBe(true);
    expect(replies.some((d) => KITTY_FLAGS_REPLY.test(d))).toBe(true);
    expect(useStore.getState().resumeHintByPtyId['p-query']).toBe('claude');
  });

  it('a real keystroke still retracts the resume hint', async () => {
    const term = await mount('p-key');
    useStore.getState().setResumeHint('p-key', 'claude');

    act(() => term.input('x', true));

    expect(written('p-key')).toContain('x');
    expect(useStore.getState().resumeHintByPtyId['p-key']).toBeUndefined();
  });

  it('typed input shaped like a reply (a modified F3 reads as a cursor report) is still the user', async () => {
    const term = await mount('p-f3');
    useStore.getState().setResumeHint('p-f3', 'claude');

    act(() => term.input('\x1b[1;2R', true));

    expect(written('p-f3')).toContain('\x1b[1;2R');
    expect(useStore.getState().resumeHintByPtyId['p-f3']).toBeUndefined();
  });
});
