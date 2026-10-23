// @vitest-environment jsdom
// A plugin page's key works only while the rail lists that plugin: once it
// is removed or denied, its stored override no longer claims the key (which
// would otherwise drop the user on Workspaces), but Settings still sees it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => ({ names: new Set<string>() as ReadonlySet<string> }));
vi.mock('../../plugins/usePlugins', () => ({ listedRailPageNames: () => listed.names }));

import { useStore } from '../../stores';
import { activeShortcutBindings, currentShortcutBindings } from '../shortcutBindings';

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'win32' };
  useStore.setState({ shortcutOverrides: { 'plugin:notes': 'Ctrl+Alt+N' } });
});

describe('activeShortcutBindings', () => {
  it('drops the key of a plugin page the rail does not list, and keeps it in the stored bindings', () => {
    listed.names = new Set();
    expect(currentShortcutBindings().some((b) => b.action === 'plugin:notes')).toBe(true);
    expect(activeShortcutBindings().some((b) => b.action === 'plugin:notes')).toBe(false);
  });

  it('keeps the key while the rail lists the plugin', () => {
    listed.names = new Set(['notes']);
    expect(activeShortcutBindings()).toContainEqual({ action: 'plugin:notes', combo: 'Ctrl+Alt+N' });
  });
});
