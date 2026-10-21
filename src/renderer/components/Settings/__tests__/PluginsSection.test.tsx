// @vitest-environment jsdom
// Install, approval, uninstall and the catalog listing moved to the Plugins
// page with the UI; their tests live in components/Plugins/__tests__.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import PluginsSection from '../PluginsSection';
import { en } from '../../../i18n/locales/en';
import { useStore } from '../../../stores';

vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

it('shows only a link to the Plugins page', async () => {
  useStore.setState({ appRoute: 'settings' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PluginsSection />));
  expect(host.querySelector('[data-setting-id="plugins"]')).not.toBeNull();
  expect(host.textContent).toContain(en['plugins.settings.moved']);
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons.map((item) => item.textContent)).toEqual([en['plugins.settings.open']]);
  await act(async () => buttons[0].click());
  expect(useStore.getState().appRoute).toBe('plugins');
});
