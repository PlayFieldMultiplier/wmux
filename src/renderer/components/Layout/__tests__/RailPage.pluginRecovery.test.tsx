// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import RailPage from '../RailPage';
import { useStore } from '../../../stores';

vi.mock('../../../plugins/PluginRailPage', () => ({
  default: ({ name }: { name: string }) => {
    if (name === 'broken') throw new Error('Plugin render failed');
    return <div>Healthy plugin: {name}</div>;
  },
}));

it('opens another plugin after the previous page throws without requiring Retry', () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const previousRoute = useStore.getState().appRoute;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => {
      useStore.setState({ appRoute: 'plugin:broken' });
      root.render(<RailPage />);
    });
    expect(host.textContent).toContain('Plugin render failed');
    act(() => { useStore.setState({ appRoute: 'plugin:healthy' }); });
    expect(host.textContent).toContain('Healthy plugin: healthy');
    expect(host.textContent).not.toContain('Plugin render failed');
  } finally {
    act(() => root.unmount());
    host.remove();
    useStore.setState({ appRoute: previousRoute });
    errors.mockRestore();
  }
});
