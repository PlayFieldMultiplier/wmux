import { describe, expect, it } from 'vitest';
import type { InstalledUiPlugin } from '../../../../shared/pluginManagement';
import { pluginActions, pluginEntryState, pluginPermissionLines, pluginSections, type PluginCatalogItem, type PluginRow } from '../pluginsModel';

const entry = (id: string, signature: boolean): PluginCatalogItem => ({
  id, signature, titleKey: 'plugins.settings.office', hintKey: 'plugins.settings.officeHint', taglineKey: 'plugins.page.officeTagline',
  glyph: 'office', capabilities: ['ui.rail-page'], readme: `https://example.invalid/${id}`, publisher: 'p', license: 'MIT', version: '1.0.0',
});
const installed = (name: string, patch: Partial<InstalledUiPlugin> = {}): InstalledUiPlugin => ({
  name, version: '1', enabled: true, managed: true, trustStatus: 'unconfirmed', capabilities: ['ui.rail-page'],
  activationEvents: [], contributes: { railPage: { title: name, entry: 'index.html' } }, ...patch,
});

describe('pluginSections', () => {
  it('lists signature entries before the rest of the catalog, from the data flag alone', () => {
    // The signature entry is second in source order on purpose.
    const sections = pluginSections([entry('plain', false), entry('star', true)], []);
    expect(sections.signature.map((row) => row.id)).toEqual(['star']);
    expect(sections.catalog.map((row) => row.id)).toEqual(['plain']);
  });

  it('gives every installed bundle outside the catalog an Installed row', () => {
    const sections = pluginSections([entry('star', true)], [installed('star'), installed('hand-made', { managed: false })]);
    expect(sections.signature[0].installed?.name).toBe('star');
    expect(sections.installed.map((row) => row.id)).toEqual(['hand-made']);
  });

  it('filters every section with the same predicate', () => {
    const sections = pluginSections([entry('star', true), entry('plain', false)], [installed('hand-made')], (row) => row.id.startsWith('s'));
    expect(sections).toEqual({ signature: [expect.objectContaining({ id: 'star' })], catalog: [], installed: [] });
  });
});

describe('pluginEntryState and pluginActions', () => {
  const row = (plugin?: InstalledUiPlugin): PluginRow => ({ id: 'star', catalog: entry('star', true), installed: plugin, state: pluginEntryState(plugin) });

  it('maps each state to one primary and its quieter actions', () => {
    expect(pluginActions(row())).toEqual({ primary: 'install', secondary: ['readme'] });
    expect(pluginActions(row(installed('star')))).toEqual({ primary: 'approve', secondary: ['uninstall'] });
    expect(pluginActions(row(installed('star', { trustStatus: 'trusted' })))).toEqual({ primary: 'open', secondary: ['disable', 'uninstall'] });
    expect(pluginActions(row(installed('star', { enabled: false, trustStatus: 'trusted' })))).toEqual({ primary: 'enable', secondary: ['uninstall'] });
  });

  it('never approves on install: denied and legacy trust still wait on a review', () => {
    expect(pluginEntryState(installed('star', { trustStatus: 'denied' }))).toBe('installed');
    expect(pluginEntryState(installed('star', { trustStatus: 'legacy' }))).toBe('installed');
  });

  it('offers no file deletion for a bundle installed by hand', () => {
    expect(pluginActions(row(installed('star', { managed: false })))).toEqual({ primary: 'approve', secondary: ['disable'] });
    expect(pluginActions(row(installed('star', { managed: false, trustStatus: 'trusted' })))).toEqual({ primary: 'open', secondary: ['disable'] });
    expect(pluginActions(row(installed('star', { managed: false, enabled: false })))).toEqual({ primary: 'enable', secondary: [] });
  });

  it('has nothing to open for an approved bundle without a rail page', () => {
    expect(pluginActions(row(installed('star', { trustStatus: 'trusted', contributes: {} }))).primary).toBeNull();
  });
});

describe('pluginPermissionLines', () => {
  it('adds a muted no-terminal line only while terminal.read is not declared', () => {
    expect(pluginPermissionLines(['agent.state.read', 'pane.read'])).toEqual([
      { capability: 'agent.state.read', labelKey: 'plugins.page.cap.agentState', granted: true },
      { capability: 'pane.read', labelKey: 'plugins.page.cap.paneRead', granted: true },
      { capability: 'terminal.read', labelKey: 'plugins.page.cap.noTerminal', granted: false },
    ]);
    expect(pluginPermissionLines(['terminal.read:w1.*'])).toEqual([
      { capability: 'terminal.read:w1.*', labelKey: 'plugins.page.cap.terminalRead', granted: true },
    ]);
    expect(pluginPermissionLines(['custom.thing'])[0]).toEqual({ capability: 'custom.thing', labelKey: null, granted: true });
  });
});
