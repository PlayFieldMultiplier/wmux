// @vitest-environment jsdom
//
// The agent toolbar's Rewind button (roadmap R2): shown only while the focused
// terminal runs Claude, disabled mid-turn with the reason, and a click opens
// Claude's Rewind picker through the same daemon call as the pane menu item.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  insertPathsIntoPty: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import ToolbarHost from '../ToolbarHost';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';
import type { AgentStatus, SessionData, Workspace } from '../../../../shared/types';

function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf-a',
      type: 'leaf',
      activeSurfaceId: 'sa1',
      surfaces: [
        { id: 'sa1', ptyId: 'pty-1', title: 'claude', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;
const rewind = vi.fn(async () => ({ result: 'opened' as const }));

beforeEach(() => {
  rewind.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', chat: { rewind } };
  setDaemonModeActive(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const data: SessionData = { workspaces: [seedWorkspace()], activeWorkspaceId: 'ws-1', sidebarVisible: true };
  act(() => {
    useStore.getState().loadSession(data);
    useStore.setState({
      toolbarPopover: null,
      fanOutWorkspaceId: null,
      agentToolbarEnabled: true,
      agentToolbarPinned: true,
      appRoute: 'workspaces',
      readOnly: false,
      surfaceAgent: {},
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDaemonModeForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function mount(): void {
  act(() => root.render(createElement(ToolbarHost)));
}

function setAgent(slug: string, status: AgentStatus): void {
  act(() => useStore.setState({ surfaceAgent: { 'pty-1': { name: slug, status, slug: slug as never } } }));
}

const rewindButton = (): HTMLButtonElement | null =>
  container.querySelector('[data-testid="toolbar-rewind"]') as HTMLButtonElement | null;

describe('AgentToolbar — Rewind', () => {
  it('is absent unless the focused terminal runs Claude', () => {
    mount();
    expect(rewindButton()).toBeNull();
    setAgent('codex', 'idle');
    expect(rewindButton()).toBeNull();
    setAgent('claude', 'idle');
    expect(rewindButton()).not.toBeNull();
  });

  it('is marked disabled while Claude is mid-turn, with the reason as its tooltip and label', () => {
    mount();
    setAgent('claude', 'running');
    // aria-disabled keeps it focusable, so keyboard users can reach the reason.
    expect(rewindButton()?.disabled).toBe(false);
    expect(rewindButton()?.getAttribute('aria-disabled')).toBe('true');
    expect(rewindButton()?.title).toBe('Claude is working — rewind once the turn ends');
    expect(rewindButton()?.getAttribute('aria-label')).toContain('Claude is working');
    setAgent('claude', 'complete');
    expect(rewindButton()?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('does nothing when clicked mid-turn', async () => {
    mount();
    setAgent('claude', 'running');
    await act(async () => { rewindButton()?.click(); });
    expect(rewind).not.toHaveBeenCalled();
  });

  it('opens the picker for the focused terminal on click', async () => {
    mount();
    setAgent('claude', 'idle');
    await act(async () => { rewindButton()?.click(); });
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(rewind).toHaveBeenCalledWith({ ptyId: 'pty-1', kitty: false });
  });

  it('is absent in a read-only window', () => {
    mount();
    act(() => useStore.setState({ readOnly: true }));
    setAgent('claude', 'idle');
    expect(rewindButton()).toBeNull();
  });
});
