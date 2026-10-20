// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ConnectorAccess from '../ConnectorAccess';
import { noTerminalAccess, type ConnectorTerminalAccess } from '../../../../shared/connectorAccess';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
it('edits selected workspaces independently and preserves unresolved exclusions for review', async () => {
  vi.stubGlobal('electronAPI', { connectorTerminal: { targets: async () => ({
    workspaces: [{ id: 'ws-a', name: 'Workspace A' }], panes: [{ id: 'pane-a', name: 'Backend', workspaceId: 'ws-a', ptyIds: ['daemon-a'] }],
  }) } });
  let saved: ConnectorTerminalAccess = { ...noTerminalAccess(), excludedPaneIds: ['pane-old'] };
  function Harness() {
    const [value, setValue] = useState(saved);
    return <ConnectorAccess value={value} onChange={(next) => { saved = next; setValue(next); }} />;
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const select = host.querySelector('select'); if (!select) throw new Error('Missing access control');
  await act(async () => { select.value = 'workspaces'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const workspace = [...host.querySelectorAll('label')].find((el) => el.textContent === 'Workspace A');
  if (!workspace) throw new Error('Missing workspace choice');
  await act(async () => workspace.click());
  expect(saved.workspaceIds).toEqual(['ws-a']);
  expect(saved.excludedPaneIds).toEqual(['pane-old']);
  expect(host.textContent).toContain('pane-old');
  await act(async () => { select.value = 'none'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(saved.mode).toBe('none');
  expect(saved.excludedPaneIds).toEqual(['pane-old']);
});
