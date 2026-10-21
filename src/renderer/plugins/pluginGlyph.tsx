import type { ComponentType } from 'react';
import { UI_PLUGIN_CATALOG, type UiPluginGlyph } from '../../shared/pluginManagement';
import { IconOffice, IconPackage, IconPulse } from '../components/icons';

const GLYPHS: Record<UiPluginGlyph, ComponentType<{ size?: number }>> = {
  office: IconOffice,
  pulse: IconPulse,
};

/** The glyph a catalog entry names; a bundle outside the catalog gets the package. */
export function PluginGlyph({ name, size = 16 }: { name: string; size?: number }) {
  const glyph = UI_PLUGIN_CATALOG.find((entry) => entry.id === name)?.glyph;
  const Glyph = glyph ? GLYPHS[glyph] : IconPackage;
  return <Glyph size={size} />;
}
