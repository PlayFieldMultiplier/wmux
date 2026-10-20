import { describe, expect, it } from 'vitest';
import { noTerminalAccess, parseTerminalAccess, terminalAccessAllows, type ConnectorTerminalAccess } from '../connectorAccess';

const inventory = { workspaceIds: new Set(['ws-a', 'ws-b']), paneIds: new Set(['pane-a', 'pane-b']) };
const target = { workspaceId: 'ws-a', paneId: 'pane-a', botWorker: false };
const policy = (patch: Partial<ConnectorTerminalAccess> = {}): ConnectorTerminalAccess => ({ ...noTerminalAccess(), mode: 'all', ...patch });

describe('ordinary terminal connector access', () => {
  it('requires an explicit grant and known live identity, including for all', () => {
    expect(terminalAccessAllows(undefined, target, inventory)).toBe(false);
    expect(terminalAccessAllows(noTerminalAccess(), target, inventory)).toBe(false);
    expect(terminalAccessAllows(policy(), target, inventory)).toBe(true);
    expect(terminalAccessAllows(policy(), { ...target, paneId: 'pane-unknown' }, inventory)).toBe(false);
    expect(terminalAccessAllows(policy(), { ...target, workspaceId: 'ws-unknown' }, inventory)).toBe(false);
    expect(terminalAccessAllows(policy(), { ...target, botWorker: true }, inventory)).toBe(false);
  });
  it('follows workspace and pane selections independently', () => {
    expect(terminalAccessAllows(policy({ mode: 'workspaces', workspaceIds: ['ws-a'] }), target, inventory)).toBe(true);
    expect(terminalAccessAllows(policy({ mode: 'workspaces', workspaceIds: ['ws-b'] }), target, inventory)).toBe(false);
    expect(terminalAccessAllows(policy({ mode: 'panes', paneIds: ['pane-a'] }), target, inventory)).toBe(true);
    expect(terminalAccessAllows(policy({ mode: 'panes', paneIds: ['pane-b'] }), target, inventory)).toBe(false);
  });
  it('never broadens access when an excluded identity disappears or is replaced', () => {
    for (const p of [policy({ excludedPaneIds: ['pane-a'] }), policy({ excludedWorkspaceIds: ['ws-a'] }),
      policy({ excludedPaneIds: ['pane-deleted'] }), policy({ excludedWorkspaceIds: ['ws-replaced'] })]) {
      expect(terminalAccessAllows(p, target, inventory)).toBe(false);
    }
    expect(terminalAccessAllows(policy({ excludedPaneIds: ['pane-b'] }), target, inventory)).toBe(true);
  });
  it('rejects malformed, unbounded and foreign identifiers', () => {
    for (const raw of [null, [], {}, { ...policy(), mode: 'legacy' }, { ...policy(), paneIds: ['ws-a'] },
      { ...policy(), workspaceIds: ['ws-a\n'] }, { ...policy(), paneIds: Array(257).fill('pane-a') }]) {
      expect(parseTerminalAccess(raw)).toBeNull();
    }
    expect(parseTerminalAccess(policy({ paneIds: ['pane-a', 'pane-a'] }))?.paneIds).toEqual(['pane-a']);
  });
});
