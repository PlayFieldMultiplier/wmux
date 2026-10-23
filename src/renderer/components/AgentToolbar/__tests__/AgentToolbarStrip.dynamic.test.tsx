// @vitest-environment jsdom
//
// The agent toolbar strip sits over the bottom 40px of the workspace column —
// the terminal's last rows and the chat composer's Dictate/Send buttons. While
// the bar is hidden, nothing in it may take a click meant for what is
// underneath; once revealed, the bar's own controls must.
//
// jsdom has no layout, so elementFromPoint cannot be asked. These tests check
// what Chromium's hit-test reads instead: an element is skipped when its
// effective `pointer-events` is none (inherited from the nearest ancestor that
// sets it) or when it sits inside an `inert` subtree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  insertPathsIntoPty: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

// Lets one test crash the bar to reach the strip's ErrorBoundary fallback.
let crashBar = false;
vi.mock('../AgentToolbar', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../AgentToolbar')>();
  return {
    ...mod,
    default: (props: Parameters<typeof mod.default>[0]) => {
      if (crashBar) throw new Error('bar crashed');
      return createElement(mod.default, props);
    },
  };
});

import { useStore } from '../../../stores';
import { AgentToolbarStrip } from '../ToolbarHost';
import { HOVER_REVEAL_DELAY_MS } from '../useHoverReveal';
import type { SessionData, Workspace } from '../../../../shared/types';

/** The workspace column: 800×600, so the trigger band is y 592..600. */
const COLUMN_RECT = {
  top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect;

function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf-a',
      type: 'leaf',
      activeSurfaceId: 'sa1',
      surfaces: [
        { id: 'sa1', ptyId: 'pty-1', title: 'shell', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

/** Whether a hit-test at this element's box would stop on it. */
function takesPointer(el: Element): boolean {
  if (el.closest('[inert]')) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const inline = (node as HTMLElement).style?.pointerEvents;
    if (inline) return inline !== 'none';
    if (node.classList.contains('pointer-events-none')) return false;
    if (node.classList.contains('pointer-events-auto')) return true;
  }
  return true;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  crashBar = false;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(COLUMN_RECT);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const data: SessionData = {
    workspaces: [seedWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => {
    useStore.getState().loadSession(data);
    useStore.setState({
      toolbarPopover: null,
      fanOutWorkspaceId: null,
      agentToolbarEnabled: true,
      agentToolbarPinned: false,
      agentToolbarTourHold: false,
      fileTreeVisible: false,
      appRoute: 'workspaces',
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(): void {
  act(() => root.render(createElement(AgentToolbarStrip)));
}

function strip(): HTMLElement {
  return container.querySelector('[data-agent-toolbar-strip]') as HTMLElement;
}

function bar(): HTMLElement {
  return container.querySelector('[data-testid="agent-toolbar"]') as HTMLElement;
}

describe('AgentToolbarStrip hit-testing', () => {
  it('lets every click through while the bar is hidden', () => {
    mount();
    expect(bar().dataset.revealed).toBe('false');
    const all = [strip(), ...Array.from(strip().querySelectorAll('*'))];
    const catchers = all.filter(takesPointer).map((el) => el.outerHTML.slice(0, 80));
    expect(catchers).toEqual([]);
  });

  it('still reveals on approach, and then only the bar controls take the pointer', () => {
    mount();
    act(() => {
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, clientY: 598, bubbles: true }));
    });
    act(() => { vi.advanceTimersByTime(HOVER_REVEAL_DELAY_MS); });
    expect(bar().dataset.revealed).toBe('true');
    expect(takesPointer(strip())).toBe(false);
    expect(takesPointer(bar())).toBe(false);
    const buttons = Array.from(bar().querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(takesPointer)).toBe(true);
  });

  it('keeps the crash fallback Retry button clickable inside the strip', () => {
    crashBar = true;
    mount();
    const retry = strip().querySelector('button') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    expect(takesPointer(strip())).toBe(false);
    expect(takesPointer(retry)).toBe(true);
  });
});
