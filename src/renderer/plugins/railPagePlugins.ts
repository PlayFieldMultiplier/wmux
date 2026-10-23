import type { ListedPlugin } from './usePlugins';

/** The plugins whose rail page the rail lists: declared, and not denied. */
export function railPagePlugins(plugins: readonly ListedPlugin[]): ListedPlugin[] {
  return plugins.filter((p) => p.contributes.railPage && p.trustStatus !== 'denied');
}
