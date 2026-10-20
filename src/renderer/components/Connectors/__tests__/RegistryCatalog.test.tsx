// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import RegistryCatalog from '../RegistryCatalog';
import { en } from '../../../i18n/locales/en';
import type { ConnectorCatalogResult } from '../../../../shared/connectorCatalog';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const entry = (id: string) => ({ id, title: id, description: 'Service', version: '1', remotes: [{ type: 'http' as const, url: 'https://example.com/mcp' }] });
const button = (key: keyof typeof en) => [...host.querySelectorAll('button')].find((b) => b.textContent === en[key]) as HTMLButtonElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
async function mount(load: (s: string, c?: string) => Promise<ConnectorCatalogResult>, onConfigure = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<RegistryCatalog load={load} onConfigure={onConfigure} canConfigure />));
}
it('paginates without duplicates and only offers a disabled draft for explicit review', async () => {
  const load = vi.fn().mockResolvedValueOnce({ ok: true, entries: [entry('calendar')], nextCursor: 'page2' }).mockResolvedValueOnce({ ok: true, entries: [entry('calendar'), entry('docs')] });
  const configure = vi.fn(); await mount(load, configure);
  expect(configure).not.toHaveBeenCalled();
  await act(async () => button('connectors.loadMore').click());
  expect(load).toHaveBeenLastCalledWith('', 'page2');
  expect(host.querySelectorAll('li')).toHaveLength(2);
  await act(async () => button('connectors.reviewSetup').click());
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, secrets: [] }));
});
it('retries registry failure', async () => {
  const load = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, entries: [entry('docs')] });
  await mount(load); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => button('connectors.retry').click());
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).toContain('docs');
});
it('ignores an older response after a fresh search', async () => {
  let resolve!: (r: ConnectorCatalogResult) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<ConnectorCatalogResult>((r) => { resolve = r; })).mockResolvedValueOnce({ ok: true, entries: [entry('fresh')] });
  await mount(load);
  await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => resolve({ ok: true, entries: [entry('obsolete')] }));
  expect(host.textContent).toContain('fresh'); expect(host.textContent).not.toContain('obsolete');
});
it('submits the service name and retains the current page when loading more fails', async () => {
  const load = vi.fn().mockResolvedValueOnce({ ok: true, entries: [] }).mockResolvedValueOnce({ ok: true, entries: [entry('calendar')], nextCursor: 'more' }).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, entries: [entry('docs')] });
  await mount(load);
  const input = host.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'calendar');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(load).toHaveBeenLastCalledWith('calendar', undefined);
  await act(async () => button('connectors.loadMore').click());
  expect(host.textContent).toContain('calendar');
  await act(async () => button('connectors.retry').click());
  expect(load).toHaveBeenLastCalledWith('calendar', 'more');
  expect(host.querySelectorAll('li')).toHaveLength(2);
});
