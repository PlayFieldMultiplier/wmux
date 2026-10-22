import { TERMINAL_CONTENT_CAPABILITIES, type InstalledUiPlugin, type UiPluginGlyph } from '../../../shared/pluginManagement';
import type { PluginPreviewId } from '../../assets/media';
import type { TranslationKey } from '../../i18n/locales/en';

/** Where a plugin stands, read from the inventory alone. */
export type PluginEntryState = 'available' | 'installed' | 'approved' | 'disabled';
export type PluginAction = 'install' | 'readme' | 'approve' | 'open' | 'enable' | 'disable' | 'uninstall';

/** The catalog fields the page reads (UI_PLUGIN_CATALOG entries satisfy it). */
export interface PluginCatalogItem {
  id: string;
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  taglineKey: TranslationKey;
  signature: boolean;
  glyph: UiPluginGlyph;
  /** A real capture of the entry's own rail page, shown in the detail. */
  preview?: PluginPreviewId;
  capabilities: readonly string[];
  readme: string;
  publisher: string;
  license: string;
  version: string;
}

/** One row of the page's list: a catalog entry, an installed bundle, or both. */
export interface PluginRow {
  id: string;
  catalog?: PluginCatalogItem;
  installed?: InstalledUiPlugin;
  state: PluginEntryState;
}

export interface PluginSections {
  signature: PluginRow[];
  catalog: PluginRow[];
  /** Installed bundles that are not in the catalog (installed by hand). */
  installed: PluginRow[];
}

export function pluginEntryState(installed: InstalledUiPlugin | undefined): PluginEntryState {
  if (!installed) return 'available';
  if (!installed.enabled) return 'disabled';
  // Only an explicit approval opens the page; unconfirmed, denied and legacy
  // trust all wait on a review.
  return installed.trustStatus === 'trusted' ? 'approved' : 'installed';
}

/**
 * The page's rows in their sections, Signature first, then Catalog, then
 * the bundles installed by hand. Sections follow the data's `signature`
 * flag, never an id. `matches` filters rows by the search query.
 */
export function pluginSections(
  catalog: readonly PluginCatalogItem[],
  plugins: readonly InstalledUiPlugin[],
  matches: (row: PluginRow) => boolean = () => true,
): PluginSections {
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));
  // A bundle installed by hand under a catalog id is not that catalog entry:
  // it keeps its own name and manifest under Installed, and the entry (which
  // cannot be installed over it) is not listed.
  const handHeld = new Set(plugins.filter((plugin) => !plugin.managed).map((plugin) => plugin.name));
  const catalogIds = new Set(catalog.map((entry) => entry.id).filter((id) => !handHeld.has(id)));
  const catalogRows = catalog.filter((entry) => catalogIds.has(entry.id)).map((entry): PluginRow => {
    const installed = byName.get(entry.id);
    return { id: entry.id, catalog: entry, installed, state: pluginEntryState(installed) };
  }).filter(matches);
  return {
    signature: catalogRows.filter((row) => row.catalog?.signature),
    catalog: catalogRows.filter((row) => !row.catalog?.signature),
    installed: plugins.filter((plugin) => !catalogIds.has(plugin.name))
      .map((plugin): PluginRow => ({ id: plugin.name, installed: plugin, state: pluginEntryState(plugin) }))
      .filter(matches),
  };
}

/**
 * What the detail offers in each state: one primary (or none) and the
 * quieter actions after it. Uninstall deletes files, so it is only offered
 * for a bundle the catalog installed; a bundle installed by hand can be
 * turned off instead. Open needs a rail page to open.
 */
export function pluginActions(row: PluginRow): { primary: PluginAction | null; secondary: PluginAction[] } {
  const managed = !!row.installed?.managed;
  const uninstall: PluginAction[] = managed ? ['uninstall'] : [];
  switch (row.state) {
    case 'available':
      return { primary: 'install', secondary: row.catalog?.readme ? ['readme'] : [] };
    case 'installed':
      return { primary: 'approve', secondary: managed ? uninstall : ['disable'] };
    case 'approved':
      return { primary: row.installed?.contributes.railPage ? 'open' : null, secondary: ['disable', ...uninstall] };
    case 'disabled':
      return { primary: 'enable', secondary: uninstall };
  }
}

/** The muted word at the end of a list row. Blank while only available. */
export const PLUGIN_STATE_LABEL_KEYS: Record<PluginEntryState, TranslationKey | null> = {
  available: null,
  installed: 'plugins.settings.notApproved',
  approved: 'plugins.page.stateOn',
  disabled: 'plugins.page.stateOff',
};

/** The muted note under the detail's actions. */
export const PLUGIN_STATE_NOTE_KEYS: Record<PluginEntryState, TranslationKey> = {
  available: 'plugins.page.noteAvailable',
  installed: 'plugins.page.noteInstalled',
  approved: 'plugins.page.noteApproved',
  disabled: 'plugins.page.noteDisabled',
};

/** Plain-language names for the capabilities a page plugin usually asks for. */
const CAPABILITY_LABEL_KEYS: Record<string, TranslationKey> = {
  'ui.rail-page': 'plugins.page.cap.railPage',
  'ui.sidebar': 'plugins.page.cap.sidebar',
  'ui.statusbar': 'plugins.page.cap.statusbar',
  'agent.state.read': 'plugins.page.cap.agentState',
  'agent.state.read.all': 'plugins.page.cap.agentStateAll',
  'pane.read': 'plugins.page.cap.paneRead',
  'terminal.read': 'plugins.page.cap.terminalRead',
};

export interface PluginPermissionLine {
  /** The capability as declared (`name[:glob]`), shown as machine evidence. */
  capability: string;
  /** A plain-language label, or null when only the capability can be shown. */
  labelKey: TranslationKey | null;
  granted: boolean;
}

/**
 * "What it can do": one granted line per declared capability, then a muted
 * line saying the page cannot read terminal content when it declares no
 * capability that reaches it (TERMINAL_CONTENT_CAPABILITIES).
 */
export function pluginPermissionLines(capabilities: readonly string[]): PluginPermissionLine[] {
  const lines = capabilities.map((capability): PluginPermissionLine => ({
    capability, labelKey: CAPABILITY_LABEL_KEYS[capability.split(':')[0]] ?? null, granted: true,
  }));
  if (!capabilities.some((capability) => TERMINAL_CONTENT_CAPABILITIES.includes(capability.split(':')[0]))) {
    lines.push({ capability: 'terminal.read', labelKey: 'plugins.page.cap.noTerminal', granted: false });
  }
  return lines;
}
