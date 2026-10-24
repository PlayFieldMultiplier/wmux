// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import type { PaneLeaf, SessionData, Workspace } from '../../../../shared/types';
import { ChatViewFirstAskCard } from '../ChatViewFirstAskCard';

const ws = () => ({
  id: 'ws-1', name: 'One', activePaneId: 'p',
  rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty-1', title: 't', shell: 'zsh', cwd: '/x', surfaceType: 'terminal' }] },
}) as unknown as Workspace;
const load = (extra: Partial<SessionData>) => useStore.getState().loadSession({ workspaces: [ws()], activeWorkspaceId: 'ws-1', sidebarVisible: true, ...extra } as SessionData);
const runAgent = (ptyId: string, name: string, slug: string) =>
  useStore.setState((s) => ({ surfaceAgent: { ...s.surfaceAgent, [ptyId]: { name, status: 'running', slug } } }) as never);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (ptyId: string) => act(() => root.render(<ChatViewFirstAskCard ptyId={ptyId} surfaceId="s" />));
const card = () => host.querySelector('.wmux-chat-first-ask');
const press = (label: string) => act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click());

describe('"Show this as a chat?" first-start question', () => {
  it('asks a new user once per agent and remembers either answer', () => {
    load({});
    runAgent('pty-1', 'Claude Code', 'claude');
    render('pty-1');
    expect(card()).not.toBeNull();
    press('Keep terminal');
    expect(card()).toBeNull();
    expect(useStore.getState().chatViewEnabled).toBe(false);
    // Claude was answered, so another Claude pane is not asked; Codex still is.
    runAgent('pty-2', 'Claude Code', 'claude');
    render('pty-2');
    expect(card()).toBeNull();
    runAgent('pty-3', 'Codex', 'codex');
    render('pty-3');
    expect(card()).not.toBeNull();
    // The answer survives a save and reload.
    const saved = useStore.getState().chatViewFirstAsk;
    load({ chatViewFirstAsk: saved });
    render('pty-2');
    expect(card()).toBeNull();
  });

  it('turns the chat view on and switches this pane to it on Show', () => {
    load({});
    runAgent('pty-1', 'Codex', 'codex');
    render('pty-1');
    press('Show');
    expect(card()).toBeNull();
    expect(useStore.getState().chatViewEnabled).toBe(true);
    const pane = useStore.getState().workspaces[0].rootPane as PaneLeaf;
    expect(pane.surfaces[0].viewMode).toBe('chat');
  });

  it.each([true, false])('never asks a user who already set the chat view (%s) and leaves the value alone', (enabled) => {
    load({ chatViewEnabled: enabled });
    runAgent('pty-1', 'Claude Code', 'claude');
    render('pty-1');
    expect(card()).toBeNull();
    expect(useStore.getState().chatViewEnabled).toBe(enabled);
  });
});
