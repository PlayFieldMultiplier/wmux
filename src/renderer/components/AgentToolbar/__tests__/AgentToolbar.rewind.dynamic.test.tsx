// @vitest-environment jsdom
//
// The agent toolbar's Rewind button: Claude's own Rewind picker, the same
// action the pane menu offers (usePaneClaudeRewind). It shows only where the
// menu item shows (a Claude pane, daemon connected, not a read-only mirror),
// is disabled while the pane reports a running turn, and a press goes through
// the menu's call and its refusal toasts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  insertPathsIntoPty: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import AgentToolbar from '../AgentToolbar';
import { usePaneClaudeRewind } from '../../Pane/usePaneClaudeRewind';
import type { PaneActionItem } from '../../Pane/PaneActionsMenu';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';
import { en } from '../../../i18n/locales/en';
import type { AgentStatus, SessionData, Workspace } from '../../../../shared/types';
import type { ClaudeRewindResult } from '../../../../shared/transcript/turnEvents';

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
let rewindResult: ClaudeRewindResult;
const rewindApi = vi.fn<(args: { ptyId: string; kitty: boolean }) => Promise<{ result: ClaudeRewindResult }>>(
  async () => ({ result: rewindResult }),
);
const pushToast = vi.fn();

function setAgent(slug: string | undefined, status: AgentStatus = 'idle'): void {
  act(() => {
    useStore.setState({
      surfaceAgent: slug ? { 'pty-1': { name: slug, status, slug: slug as never } } : {},
    });
  });
}

beforeEach(() => {
  rewindResult = 'opened';
  rewindApi.mockClear();
  pushToast.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { chat: { rewind: rewindApi } };
  setDaemonModeActive(true);
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
      readOnly: false,
      pushToast,
    });
  });
  setAgent('claude');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDaemonModeForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const noop = () => undefined;

function mount(): void {
  act(() => root.render(createElement(AgentToolbar, {
    barHandlers: { onPointerEnter: noop, onPointerLeave: noop },
    revealed: true,
    onHoldChange: noop,
    onFocusEnter: noop,
  })));
}

const rewindButton = (): HTMLButtonElement | null =>
  container.querySelector('[data-testid="toolbar-rewind"]');

function shownRewindButton(): HTMLButtonElement {
  const btn = rewindButton();
  if (!btn) throw new Error('Rewind button not rendered');
  return btn;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); });
}

describe('AgentToolbar — Rewind', () => {
  it('shows an enabled Rewind button for an idle Claude pane', () => {
    mount();
    const btn = shownRewindButton();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe(en['toolbar.rewind']);
    expect(btn.title).toBe(en['pane.rewindHint']);
  });

  it('does not draw the Schedule clock beside it', () => {
    mount();
    const rewindIcon = shownRewindButton().querySelector('svg')?.innerHTML;
    const scheduleIcon = container.querySelector('[data-testid="session-schedule-button"] svg')?.innerHTML;
    expect(rewindIcon).toBeTruthy();
    expect(scheduleIcon).toBeTruthy();
    expect(rewindIcon).not.toBe(scheduleIcon);
  });

  it('is not shown for a pane that does not run Claude', () => {
    setAgent('codex');
    mount();
    expect(rewindButton()).toBeNull();
    setAgent(undefined);
    expect(rewindButton()).toBeNull();
  });

  it('is not shown in a read-only mirror (allowed=false)', () => {
    act(() => { useStore.setState({ readOnly: true }); });
    mount();
    expect(rewindButton()).toBeNull();
  });

  it('is not shown without the daemon, like the menu item', () => {
    setDaemonModeActive(false);
    mount();
    expect(rewindButton()).toBeNull();
  });

  it('is disabled while the pane reports a running turn, and says why', async () => {
    setAgent('claude', 'running');
    mount();
    const btn = shownRewindButton();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(en['pane.rewindBusy']);
    await click(btn);
    expect(rewindApi).not.toHaveBeenCalled();
    // The turn ends: the button comes back.
    setAgent('claude', 'idle');
    expect(shownRewindButton().disabled).toBe(false);
  });

  it('a press calls the same rewind API as the pane menu item', async () => {
    let menuItems: PaneActionItem[] = [];
    function MenuProbe() {
      menuItems = usePaneClaudeRewind({ ptyId: 'pty-1', allowed: true });
      return null;
    }
    mount();
    await click(shownRewindButton());
    expect(rewindApi).toHaveBeenCalledTimes(1);
    const fromToolbar = rewindApi.mock.calls[0][0];
    expect(fromToolbar).toEqual({ ptyId: 'pty-1', kitty: false });

    const probe = document.createElement('div');
    const probeRoot = createRoot(probe);
    act(() => probeRoot.render(createElement(MenuProbe)));
    expect(menuItems).toHaveLength(1);
    await act(async () => { menuItems[0].onSelect(); });
    expect(rewindApi).toHaveBeenCalledTimes(2);
    expect(rewindApi.mock.calls[1][0]).toEqual(fromToolbar);
    act(() => probeRoot.unmount());
    expect(pushToast).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', 'pane.rewindBusy', 'warn'],
    ['draft', 'pane.rewindDraft', 'warn'],
    ['blocked', 'pane.rewindBlocked', 'warn'],
    ['retry', 'pane.rewindRetry', 'warn'],
    ['unavailable', 'pane.rewindUnavailable', 'warn'],
    ['error', 'pane.rewindUnavailable', 'error'],
  ] as const)('a %s refusal shows the menu\'s toast', async (result, key, level) => {
    rewindResult = result;
    mount();
    await click(shownRewindButton());
    expect(pushToast).toHaveBeenCalledWith({ level, message: en[key] });
  });

  it('leaves the menu item offered while busy (the menu still defers to the daemon)', () => {
    setAgent('claude', 'running');
    let menuItems: PaneActionItem[] = [];
    function MenuProbe() {
      menuItems = usePaneClaudeRewind({ ptyId: 'pty-1', allowed: true });
      return null;
    }
    act(() => root.render(createElement(MenuProbe)));
    expect(menuItems.map((i) => i.key)).toEqual(['claude-rewind']);
  });
});
