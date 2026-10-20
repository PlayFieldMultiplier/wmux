// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ConnectorTerminal from '../ConnectorTerminal';
import { en } from '../../../i18n/locales/en';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
async function mount(enabled: boolean) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorTerminal id="con-12345678" enabled={enabled} />));
}
it('launches only into the selected destination without copying a command', async () => {
  const launch = vi.fn(async () => ({ ok: true }));
  const targets = vi.fn(async () => ({ workspaces: [{ id: 'ws-a', name: 'Work' }], panes: [{ id: 'pane-a', workspaceId: 'ws-a', ptyIds: ['daemon-a'] }] }));
  vi.stubGlobal('electronAPI', { connectorTerminal: { launch, targets } });
  await mount(true);
  expect(host.querySelector('button')!.disabled).toBe(true);
  await act(async () => { const select = host.querySelector('select')!; select.value = 'daemon-a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => host.querySelector('button')!.click());
  expect(launch).toHaveBeenCalledWith('con-12345678', 'claude', 'daemon-a');
  expect(host.textContent).toContain(en['connectors.access.started']);
});
it('does not start a connection whose access is disabled', async () => {
  const launch = vi.fn();
  vi.stubGlobal('electronAPI', { connectorTerminal: { launch, targets: async () => null } });
  await mount(false);
  expect([...host.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  expect(launch).not.toHaveBeenCalled();
});
