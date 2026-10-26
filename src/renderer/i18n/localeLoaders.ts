import type { TranslationKey } from './locales/en';
import type { Locale } from './index';

export type LocaleTable = Partial<Record<TranslationKey, string>>;

/**
 * Every locale's table but English, each behind its own dynamic import, so a
 * bundle carries none of them and loads only the one it needs. The renderer
 * (i18n/index.ts, which ships English as the fallback) and main
 * (main/quit/quitAndStopCopy.ts) both load through this map.
 */
export const LOCALE_LOADERS: Readonly<Record<Exclude<Locale, 'en'>, () => Promise<LocaleTable>>> = {
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
