// The Bots page's way to the factory's settings: the empty states' button,
// and "+" in a build whose bot port cannot create bots in place.
import { useStore } from '../../stores';

/** The factory's settings page (Settings › Bots), by its tab id. */
export const FACTORY_SETTINGS_TAB = 'factory';

export function openFactorySettings(): void {
  useStore.getState().openSettingsTab(FACTORY_SETTINGS_TAB);
}
