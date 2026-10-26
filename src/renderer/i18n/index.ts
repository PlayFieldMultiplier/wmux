/**
 * Lightweight i18n system — no external library, no React Context.
 * Usage:
 *   import { t, setLocale, getLocale } from '../i18n';
 *   t('sidebar.workspaces')        => "Workspaces"
 *   t('terminal.exited', { code: 1 }) => "Process exited with code 1"
 */

import { en, type TranslationKey } from './locales/en';

export type Locale =
  | 'en'
  | 'ko'
  | 'ja'
  | 'zh'
  | 'zh-TW'
  | 'ar'
  | 'bs'
  | 'da'
  | 'de'
  | 'es'
  | 'fr'
  | 'hi'
  | 'id'
  | 'it'
  | 'ms'
  | 'nb'
  | 'pl'
  | 'pt-BR'
  | 'ru'
  | 'th'
  | 'tr'
  | 'uk'
  | 'vi';

// All translation maps share the same key set defined by the `en` locale.
// Partial<> lets other locales fall back to `en` for missing keys.
type TranslationMap = Record<TranslationKey, string>;

// Only English, the fallback, ships in the bundle. Every other table is its
// own chunk, loaded when a window first needs it (the main process loads them
// the same way: main/quit/quitAndStopCopy.ts).
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Partial<TranslationMap>>> = {
  ko: async () => (await import('./locales/ko')).ko,
  ja: async () => (await import('./locales/ja')).ja,
  zh: async () => (await import('./locales/zh')).zh,
  'zh-TW': async () => (await import('./locales/zh-TW')).zhTW,
  ar: async () => (await import('./locales/ar')).ar,
  bs: async () => (await import('./locales/bs')).bs,
  da: async () => (await import('./locales/da')).da,
  de: async () => (await import('./locales/de')).de,
  es: async () => (await import('./locales/es')).es,
  fr: async () => (await import('./locales/fr')).fr,
  hi: async () => (await import('./locales/hi')).hi,
  id: async () => (await import('./locales/id')).id,
  it: async () => (await import('./locales/it')).it,
  ms: async () => (await import('./locales/ms')).ms,
  nb: async () => (await import('./locales/nb')).nb,
  pl: async () => (await import('./locales/pl')).pl,
  'pt-BR': async () => (await import('./locales/pt-BR')).ptBR,
  ru: async () => (await import('./locales/ru')).ru,
  th: async () => (await import('./locales/th')).th,
  tr: async () => (await import('./locales/tr')).tr,
  uk: async () => (await import('./locales/uk')).uk,
  vi: async () => (await import('./locales/vi')).vi,
};

const translations: Partial<Record<Locale, Partial<TranslationMap>>> = { en: en as TranslationMap };

// ─── State ────────────────────────────────────────────────────────────────────

let currentLocale: Locale = 'en';

// ─── Public API ───────────────────────────────────────────────────────────────

export function getLocale(): Locale {
  return currentLocale;
}

/** Whether `locale`'s table is in, so switching to it shows it at once. */
export function isLocaleLoaded(locale: Locale): boolean {
  return translations[locale] !== undefined;
}

/**
 * Load `locale`'s table once. Never rejects: a table that fails to load, or
 * a locale with none, leaves `t()` on the English fallback.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (isLocaleLoaded(locale)) return;
  const loader = (LOADERS as Partial<Record<Locale, () => Promise<Partial<TranslationMap>>>>)[locale];
  if (!loader) return;
  try {
    translations[locale] = await loader();
  } catch (err) {
    console.error(`[i18n] could not load the ${locale} table`, err);
  }
}

/**
 * Switch the language. A table not loaded yet reads as English until it is,
 * so callers that can wait load it first (`loadLocale`).
 */
export function setLocale(locale: Locale): void {
  // The page's language follows the app's, so screen readers, hyphenation
  // and CJK glyph choice read the UI as written.
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  // A reload starts in the language on screen now, not the one the window
  // was built with (`resolveStartLocale`).
  try {
    window.sessionStorage.setItem(START_LOCALE_STORAGE_KEY, locale);
  } catch {
    // no window (node tests) or no storage: a reload starts in main's locale
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
}

/** The page's sessionStorage key for the language on screen; it outlives a reload, not the window. */
export const START_LOCALE_STORAGE_KEY = 'wmux:start-locale';

/**
 * The language a window's first render is in: the one on screen before a
 * reload, else the one main read from the session, else English, which is
 * also what a first launch with nothing saved shows.
 */
export function resolveStartLocale(stored: string | null | undefined, fromMain: string | null | undefined): Locale {
  return [stored, fromMain].find((l): l is Locale => SUPPORTED_LOCALES.includes(l as Locale)) ?? 'en';
}

/**
 * Translate a key with optional interpolation.
 * Variables in the template are replaced with {varName} syntax.
 *
 * @example
 * t('terminal.exited', { code: 1 }) // "Process exited with code 1"
 */
// `string & {}` keeps autocompletion for known keys while taking any string.
// eslint-disable-next-line @typescript-eslint/ban-types
export function t(key: TranslationKey | (string & {}), vars?: Record<string, string | number>): string {
  const k = key as TranslationKey;
  let str: string = (translations[currentLocale]?.[k] ?? en[k] ?? key) as string;

  if (vars) {
    // One pass over the template, with a replacer FUNCTION, not a replacement
    // string: `String.replace` reads `$&`, `$$`, "$`" and `$'` in a
    // replacement string as patterns, so a value containing one would splice
    // the match back into the result (`{message}` reappearing verbatim)
    // instead of being inserted. One pass, so an inserted value is never read
    // as a template: a task titled "Fix {pane}" keeps its braces. Values used
    // to be counts and names; they are now raw `Error.message`,
    // agent-authored titles and pane titles carrying paths.
    str = str.replace(/\{([^{}]+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  }

  return str;
}

/** All supported locales with display names (native script). */
export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文 (简体)' },
  { value: 'zh-TW', label: '中文 (繁體)' },
  { value: 'ar', label: 'العربية' },
  { value: 'bs', label: 'Bosanski' },
  { value: 'da', label: 'Dansk' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nb', label: 'Norsk Bokmål' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'uk', label: 'Українська' },
  { value: 'vi', label: 'Tiếng Việt' },
];

const SUPPORTED_LOCALES = LOCALE_OPTIONS.map((o) => o.value);

/**
 * Map a raw OS/BCP-47 locale string (`navigator.language`, e.g. `'pl-PL'`,
 * `'zh-Hant-TW'`, `'pt-BR'`) to one of our 23 supported locales, falling back
 * to `'en'` when nothing reasonable matches.
 *
 * Pure and total — never throws on garbage input, since the caller is
 * first-run session load and a bad OS locale string must not be able to
 * block the app from opening.
 *
 * Two passes:
 *   1. Exact match, case-insensitive, against the full tag — catches the two
 *      locales whose OWN id carries a region (`zh-TW`, `pt-BR`) when the OS
 *      reports that exact region back.
 *   2. Primary-subtag match — `'pl-PL'` -> `'pl'`, `'de-AT'` -> `'de'`. `zh`
 *      gets special handling here: a Traditional-script/Taiwan/HK/Macau
 *      signal (`Hant`, `-TW`, `-HK`, `-MO`) maps to `'zh-TW'` and everything
 *      else that starts with `zh` maps to `'zh'` — those two are NOT mutually
 *      readable, so guessing wrong is worse than the generic English
 *      fallback would be for most other locales.
 *
 * Anything that matches neither pass — including a locale we simply don't
 * ship a translation for — returns `'en'`.
 */
export function detectSupportedLocale(
  systemLocale: string,
  supported: readonly Locale[] = SUPPORTED_LOCALES,
): Locale {
  const tag = (systemLocale || '').trim().toLowerCase();
  if (!tag) return 'en';

  const supportedLower = new Map<string, Locale>(supported.map((l) => [l.toLowerCase(), l]));

  const exact = supportedLower.get(tag);
  if (exact) return exact;

  const primary = tag.split('-')[0];

  if (primary === 'zh') {
    const isTraditional = /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag);
    const zhVariant: Locale = isTraditional ? 'zh-TW' : 'zh';
    return supported.includes(zhVariant) ? zhVariant : 'en';
  }

  const byPrimary = supported.find((l) => l.toLowerCase().split('-')[0] === primary);
  return byPrimary ?? 'en';
}
