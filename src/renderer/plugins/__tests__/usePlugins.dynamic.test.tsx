// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePlugins } from '../usePlugins';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function View() { const state = usePlugins(); return <div>{state.plugins.map((plugin) => plugin.name).join(',')}</div>; }

it('retires mounted contributions immediately and ignores a late list from before removal', async () => {
  const old = { plugins: [{ name: 'retired' }, { name: 'unaffected' }], failures: [] };
  let resolveOld!: (value: typeof old) => void;
  let changed!: (name: string) => void;
  const unsubscribe = vi.fn();
  const list = vi.fn().mockResolvedValueOnce(old)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue({ plugins: [{ name: 'unaffected' }], failures: [] });
  vi.stubGlobal('electronAPI', { plugins: { list }, pluginManagement: { onChanged: (callback: (name: string) => void) => { changed = callback; return unsubscribe; } } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<View />));
    expect(host.textContent).toBe('retired,unaffected');
    await act(async () => changed('retired'));
    expect(host.textContent).toBe('unaffected');
    await act(async () => changed('retired'));
    await act(async () => resolveOld(old));
    expect(host.textContent).toBe('unaffected');
    expect(list).toHaveBeenCalledTimes(3);
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  expect(unsubscribe).toHaveBeenCalledOnce();
});
