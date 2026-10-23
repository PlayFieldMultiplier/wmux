// @vitest-environment jsdom
//
// The remote-spawn card: another PC asks this one to start an agent. It names
// the PC, the agent, the folder and the mode, shows the whole prompt as text,
// says plainly what allowing means, and answers Allow once / Always allow this
// PC, folder and agent / Deny. A follow-up card has no "Always".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { APPROVAL_ACTIVATION_DELAY_MS } from '../useActivationGuard';
import PermissionApprovalDialogContainer from '../PermissionApprovalDialogContainer';
import { selectApprovalInbox } from '../../../stores/selectors/approvalInbox';
import type { ApprovalPromptInfo, RemoteSpawnPromptInfo } from '../../../../main/mcp/ApprovalQueue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const resolveMock = vi.fn();

const SPAWN: RemoteSpawnPromptInfo = {
  hostId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  hostName: 'DESK',
  agent: 'claude',
  folder: '/Users/me/work/app/web',
  permissionMode: 'acceptEdits',
  followUps: 'ask',
  text: 'Fix the login test',
};

function prompt(spawn: Partial<RemoteSpawnPromptInfo> = {}): ApprovalPromptInfo {
  return {
    promptId: 'p1',
    clientName: 'DESK',
    declaredCapabilities: [],
    kind: 'remote-spawn',
    remoteSpawn: { ...SPAWN, ...spawn },
  };
}

function show(info: ApprovalPromptInfo): void {
  act(() => useStore.setState({ mcpPrompts: { p1: info }, mcpPromptOrder: ['p1'] } as never));
  // A remounted card opens a fresh activation guard; let it pass.
  vi.setSystemTime(Date.now() + APPROVAL_ACTIVATION_DELAY_MS + 50);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { electronAPI: unknown }).electronAPI = { permissionPrompt: { resolve: resolveMock } };
  resolveMock.mockReset();
  act(() => useStore.setState({ mcpPrompts: { p1: prompt() }, mcpPromptOrder: ['p1'] } as never));
  act(() => root.render(createElement(PermissionApprovalDialogContainer)));
  vi.setSystemTime(Date.now() + APPROVAL_ACTIVATION_DELAY_MS + 50);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ mcpPrompts: {}, mcpPromptOrder: [] } as never));
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});

const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
const row = (key: string) => container.querySelector(`[data-remote-spawn-row="${key}"]`)?.textContent ?? '';
const meaning = () => container.querySelector('[data-remote-spawn-meaning]')?.textContent;

describe('remote-spawn card', () => {
  it('names the PC, agent, folder and mode, with three answers', () => {
    expect(container.textContent).toContain('DESK wants to start Claude Code here');
    expect(row('pc')).toContain('DESK');
    expect(row('agent')).toContain('Claude Code');
    expect(row('folder')).toContain('/Users/me/work/app/web');
    expect(row('mode')).toContain('Accept edits');
    // Claude takes the mode, so no note.
    expect(container.querySelector('[data-remote-spawn-mode-note]')).toBeNull();
    expect(button('Allow once')).toBeTruthy();
    expect(button('Always allow this PC, folder and agent')).toBeTruthy();
    expect(button('Deny')).toBeTruthy();
    expect(button('Approve')).toBeUndefined();
  });

  it('shows a 20k-character prompt whole, as text', () => {
    const text = `<b>bold</b><script>x()</script>\n${'y'.repeat(20_000 - 32)}`;
    expect(text).toHaveLength(20_000);
    show(prompt({ text }));
    const pre = container.querySelector('[data-remote-spawn-prompt]');
    expect(pre?.textContent).toBe(text);
    expect(pre?.querySelector('b, script')).toBeNull();
  });

  it('says a non-Claude agent ignores the mode', () => {
    show(prompt({ agent: 'codex' }));
    expect(container.textContent).toContain('wants to start Codex CLI here');
    expect(container.querySelector('[data-remote-spawn-mode-note]')?.textContent).toBe('The mode applies to Claude only.');
  });

  it('the sentence follows the follow-up setting', () => {
    expect(meaning()).toBe('Allowing this lets DESK run this agent as you in this folder. Each later instruction asks again.');
    show(prompt({ followUps: 'direct' }));
    expect(meaning()).toBe(
      'Allowing this lets DESK run this agent as you in this folder. Its later instructions arrive without asking again.',
    );
  });

  it('Allow once resolves without remember; Always carries it', () => {
    act(() => button('Allow once')!.click());
    expect(resolveMock).toHaveBeenCalledWith('p1', true);
    expect(resolveMock.mock.calls[0]).toHaveLength(2);
    act(() => useStore.setState({ mcpPrompts: {}, mcpPromptOrder: [] } as never));
    show(prompt());
    act(() => button('Always allow this PC, folder and agent')!.click());
    expect(resolveMock).toHaveBeenLastCalledWith('p1', true, { remember: true });
  });

  it('a follow-up card has its own title and sentence, and no Always', () => {
    show(prompt({ followUp: true, followUps: 'ask', text: 'Now run the e2e suite' }));
    expect(container.textContent).toContain('DESK sent a new instruction');
    expect(meaning()).toBe('Allowing this sends this instruction to the agent DESK started here.');
    expect(container.querySelector('[data-remote-spawn-prompt]')?.textContent).toBe('Now run the e2e suite');
    expect(button('Always allow')).toBeUndefined();
    expect(button('Allow once')).toBeTruthy();
  });

  it('Deny resolves false', () => {
    act(() => button('Deny')!.click());
    expect(resolveMock).toHaveBeenCalledWith('p1', false);
  });

  it('is critical in the inbox and carries its info', () => {
    const [item] = selectApprovalInbox(useStore.getState());
    expect(item.source).toBe('mcp');
    if (item.source !== 'mcp') return;
    expect(item.isCritical).toBe(true);
    expect(item.remoteSpawn?.hostName).toBe('DESK');
  });
});
