import type { PluginHostPluginSummary } from './pluginHost';

export const PLUGIN_MANAGEMENT_IPC = {
  list: 'plugins:manage-list',
  install: 'plugins:install',
  enabled: 'plugins:set-enabled',
  remove: 'plugins:remove',
  changed: 'plugins:changed',
} as const;

/** Curated, shipped originals only. IDs never resolve arbitrary paths or URLs. */
export const UI_PLUGIN_CATALOG = [{
  id: 'agent-state-page',
  name: 'Agent status',
  publisher: 'wmux',
  license: 'MIT',
  version: '1.0.0',
  files: ['manifest.json', 'page.html', 'README.md', 'LICENSE'],
}] as const;

export interface InstalledUiPlugin extends PluginHostPluginSummary {
  enabled: boolean;
  managed: boolean;
  invalid?: boolean;
}

export interface UiPluginInventory {
  plugins: InstalledUiPlugin[];
  failures: Array<{ name: string; errors: string[] }>;
}
