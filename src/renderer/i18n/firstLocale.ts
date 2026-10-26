// The language a window's first render is in, and the load of its table.
// index.tsx imports this before the app, so the table loads while the rest
// of the bundle evaluates rather than after it.
import { START_LOCALE_STORAGE_KEY, loadLocale, resolveStartLocale } from './index';

function storedStartLocale(): string | null {
  try {
    return window.sessionStorage.getItem(START_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export const firstLocale = resolveStartLocale(storedStartLocale(), window.electronAPI?.startLocale);
export const firstLocaleLoaded = loadLocale(firstLocale);
