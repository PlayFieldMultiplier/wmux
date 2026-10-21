// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import PluginsSection from '../PluginsSection';
import { en } from '../../../i18n/locales/en';
import { UI_PLUGIN_CATALOG, type InstalledUiPlugin } from '../../../../shared/pluginManagement';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
vi.mock('../../Connectors/ConnectorsPage', () => ({ default: ({ selectedView }: { selectedView: string }) => <div data-connectors-view={selectedView} /> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function button(text: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
const plugin: InstalledUiPlugin = { name: 'agent-state-page', version: '1', enabled: true, managed: true,
  trustStatus: 'denied', capabilities: ['ui.rail-page'], activationEvents: [], contributes: { railPage: { title: 'Agent status', entry: 'page.html' } } };
async function mount(initial: InstalledUiPlugin[]) {
  let plugins = initial;
  const requestApproval = vi.fn(async () => ({ approved: false }));
  const api = {
    list: vi.fn(async () => ({ plugins, failures: [] })), onChanged: vi.fn(() => () => undefined),
    install: vi.fn(async () => { plugins = [plugin]; }), remove: vi.fn(async () => { plugins = []; }), setEnabled: vi.fn(async () => undefined),
  };
  vi.stubGlobal('electronAPI', { pluginManagement: api, plugins: { list: api.list, requestApproval } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PluginsSection />));
  return { api, requestApproval };
}

it('installs without auto-approval and exposes the same view to connectors', async () => {
  const { api, requestApproval } = await mount([]);
  await act(async () => button('Discover').click());
  expect(host.querySelector('[data-connectors-view="discover"]')).not.toBeNull();
  await act(async () => button('Install', host.querySelector('[data-catalog-entry="agent-state-page"]')!).click());
  expect(api.install).toHaveBeenCalledExactlyOnceWith('agent-state-page');
  expect(requestApproval).not.toHaveBeenCalled();
  expect(host.querySelector('[data-connectors-view="mine"]')).not.toBeNull();
  expect(host.textContent).toContain('Not approved');
  await act(async () => button('Review permissions to open').click());
  expect(requestApproval).toHaveBeenCalledExactlyOnceWith('agent-state-page');
});

it('requires confirmation to remove a catalog bundle', async () => {
  const { api } = await mount([plugin]);
  await act(async () => button('Uninstall').click());
  expect(api.remove).not.toHaveBeenCalled();
  expect(button('Cancel')).toBe(document.activeElement);
  await act(async () => button('Uninstall').click());
  expect(api.remove).toHaveBeenCalledExactlyOnceWith('agent-state-page');
  expect(host.querySelector('[data-ui-plugin]')).toBeNull();
});

it('does not offer file deletion for a manual installation', async () => {
  const { api } = await mount([{ ...plugin, managed: false }]);
  expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Uninstall')).toBe(false);
  await act(async () => button('Disable').click());
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith('agent-state-page', false);
  expect(api.remove).not.toHaveBeenCalled();
});

it('lists each catalog entry under its own name, hint and publisher', async () => {
  await mount([{ ...plugin, name: 'office' }]);
  expect(host.textContent).toContain('office · 1 · bluemas · MIT');
  await act(async () => button('Discover').click());
  expect(host.textContent).toContain(en['plugins.settings.agentStatusHint']);
  expect(host.textContent).toContain(en['plugins.settings.officeHint']);
  expect(host.textContent).toContain('bluemas · MIT · 1.0.0');
  expect(host.textContent).toContain('wmux · MIT · 1.0.0');
});

it('gives every catalog entry an English title and hint', () => {
  for (const entry of UI_PLUGIN_CATALOG) {
    expect(en[entry.titleKey]).toBeTruthy();
    expect(en[entry.hintKey]).toBeTruthy();
  }
});
