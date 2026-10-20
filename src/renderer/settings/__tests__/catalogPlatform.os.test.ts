import { describe, expect, it } from 'vitest';
import { SETTINGS_CATALOG, catalogEntryOnPlatform } from '../catalog';

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
