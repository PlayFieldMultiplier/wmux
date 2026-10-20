// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ServiceCatalog from '../ServiceCatalog';
import { en } from '../../../i18n/locales/en';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('shows service prerequisites and prepares a disabled Gmail connection only on request', async () => {
  const configure = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ServiceCatalog canConfigure onConfigure={configure} />));
  expect(host.querySelectorAll('li')).toHaveLength(12);
  expect(host.textContent).not.toContain('Developer Preview');
  await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  expect(host.querySelectorAll('li')).toHaveLength(24);
  expect(host.textContent).toContain('Developer Preview');
  expect(configure).not.toHaveBeenCalled();
  const gmail = [...host.querySelectorAll('li')].find((li) => li.querySelector('h3')?.textContent === 'Gmail')!;
  await act(async () => gmail.querySelector('button')!.click());
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ name: 'gmail', enabled: false, tools: { mode: 'listed', allowed: [] } }));
  const select = host.querySelector('select')!;
  await act(async () => { select.value = 'design'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Figma', 'Canva']);
});
