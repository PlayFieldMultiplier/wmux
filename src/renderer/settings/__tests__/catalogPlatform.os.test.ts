import { describe, expect, it } from 'vitest';
import { SETTINGS_CATALOG, catalogEntryFor, catalogEntryOnPlatform, catalogKeysOn } from '../catalog';
import { matchSettings } from '../searchSettings';
import { en } from '../../i18n/locales/en';

describe('catalogEntryOnPlatform', () => {
  it('lists the window glass row on macOS and Windows, never on Linux', () => {
    const glass = SETTINGS_CATALOG.find((entry) => entry.id === 'windowglass');
    expect(glass).toBeDefined();
    if (!glass) return;
    expect(catalogEntryOnPlatform(glass, 'darwin')).toBe(true);
    expect(catalogEntryOnPlatform(glass, 'win32')).toBe(true);
    expect(catalogEntryOnPlatform(glass, 'linux')).toBe(false);
    expect(catalogEntryOnPlatform(glass, undefined)).toBe(false);
  });

  it('takes a single platform, a list, or none for everywhere', () => {
    const base = { id: 'x', tab: 'appearance', labelKey: 'settings.windowGlass', synonyms: '' } as const;
    expect(catalogEntryOnPlatform({ ...base }, 'linux')).toBe(true);
    expect(catalogEntryOnPlatform({ ...base, platform: 'darwin' }, 'darwin')).toBe(true);
    expect(catalogEntryOnPlatform({ ...base, platform: 'darwin' }, 'win32')).toBe(false);
    expect(catalogEntryOnPlatform({ ...base, platform: ['linux', 'win32'] }, 'win32')).toBe(true);
  });
});

describe('per-platform wording', () => {
  const t = (key: string): string => (en as Record<string, string>)[key] ?? key;
  const catalogOn = (platform: string) => SETTINGS_CATALOG
    .filter((entry) => catalogEntryOnPlatform(entry, platform))
    .map((entry) => catalogEntryFor(entry, platform));

  it('swaps in the platform keys and keeps the rest of the entry', () => {
    expect(catalogKeysOn('sidebarexplorerbutton', 'darwin').labelKey).toBe('settings.sidebarShowExplorerButton.darwin');
    expect(catalogKeysOn('sidebarexplorerbutton', 'win32').labelKey).toBe('settings.sidebarShowExplorerButton');
    expect(catalogKeysOn('toolbar', 'darwin')).toEqual({ labelKey: 'settings.agentToolbarShow', descKey: 'settings.agentToolbarShowDesc.darwin' });
    expect(catalogKeysOn('version', undefined).labelKey).toBe('settings.aboutTagline');
  });

  it('searches the wording the row shows on that platform', () => {
    expect(matchSettings('finder', t, catalogOn('darwin')).map((h) => h.entry.labelKey)).toContain('settings.sidebarShowExplorerButton.darwin');
    const macVersion = catalogOn('darwin').find((e) => e.id === 'version');
    expect(t(macVersion?.labelKey ?? '')).not.toMatch(/Windows/);
  });

  it('leaves the startup row out of search on Linux, where it is not rendered', () => {
    expect(catalogOn('linux').some((e) => e.id === 'startup')).toBe(false);
    expect(catalogOn('darwin').some((e) => e.id === 'startup')).toBe(true);
  });

  it('names a key that exists for every platform variant', () => {
    for (const entry of SETTINGS_CATALOG) {
      for (const keys of Object.values(entry.platformKeys ?? {})) {
        for (const key of [keys?.labelKey, keys?.descKey]) if (key) expect(en).toHaveProperty([key]);
      }
    }
  });
});
