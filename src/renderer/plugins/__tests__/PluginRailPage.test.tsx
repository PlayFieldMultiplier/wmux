// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PluginRailPage from '../PluginRailPage';
import { useStore } from '../../stores';
import type { PluginHostPluginSummary } from '../../../shared/pluginHost';
const mock = vi.hoisted(() => ({ plugins: [] as PluginHostPluginSummary[] }));
vi.mock('../usePlugins', () => ({ usePlugins: () => ({ plugins: mock.plugins, loaded: true }), refreshPlugins: vi.fn() }));
vi.mock('../../hooks/useT', () => ({ useT: () => (key: string) => key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });
function setup(status: PluginHostPluginSummary['trustStatus']) {
  mock.plugins = [{ name: 'agents', version: '1', capabilities: ['ui.rail-page'], activationEvents: [], trustStatus: status, contributes: { railPage: { title: 'Agent page', entry: 'page.html' } } }];
  useStore.setState({ appRoute: 'plugin:agents' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root?.render(<PluginRailPage name="agents" />));
}
describe('plugin rail page mount gate', () => {
  it('does not mount an unapproved iframe', () => {
    setup('unconfirmed');
    expect(host?.querySelector('iframe')).toBeNull();
    expect(host?.textContent).toContain('plugins.page.approve');
  });
  it('mounts only a trusted sandboxed iframe and removes it on leaving', () => {
    setup('trusted');
    const frame = host?.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe('wmux-plugin://agents/page.html');
    act(() => root?.render(null));
    expect(host?.querySelector('iframe')).toBeNull();
  });
  it('returns to workspaces if the selected plugin becomes unavailable', () => {
    setup('trusted');
    mock.plugins = [];
    act(() => root?.render(<PluginRailPage name="agents" />));
    expect(host?.querySelector('iframe')).toBeNull();
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});
