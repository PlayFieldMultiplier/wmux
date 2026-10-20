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
it('prepares only the clicked agent and clears the copied capability through the ephemeral clipboard', async () => {
  const launchCommand = vi.fn(async () => ({ ok: true, command: 'prepared-command' }));
  const writeEphemeral = vi.fn(async () => undefined);
  vi.stubGlobal('electronAPI', { connectorTerminal: { launchCommand } });
  vi.stubGlobal('clipboardAPI', { writeEphemeral });
  await mount(true);
  expect(launchCommand).not.toHaveBeenCalled();
  await act(async () => host.querySelectorAll('button')[1].click());
  expect(launchCommand).toHaveBeenCalledWith('con-12345678', 'codex');
  expect(writeEphemeral).toHaveBeenCalledWith('prepared-command', 60000);
  expect(host.textContent).toContain('Launch copied');
});
it('disables launch without tool permission and reports clipboard failures accurately', async () => {
  const launchCommand = vi.fn(async () => ({ ok: true, command: 'prepared-command' }));
  vi.stubGlobal('electronAPI', { connectorTerminal: { launchCommand } });
  vi.stubGlobal('clipboardAPI', { writeEphemeral: vi.fn().mockRejectedValue(new Error('locked')) });
  await mount(false);
  expect([...host.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  await act(async () => root.render(<ConnectorTerminal id="con-12345678" enabled />));
  await act(async () => host.querySelector('button')?.click());
  expect(host.textContent).toContain('Could not prepare launch');
  expect(host.textContent).not.toContain('Launch copied');
});
