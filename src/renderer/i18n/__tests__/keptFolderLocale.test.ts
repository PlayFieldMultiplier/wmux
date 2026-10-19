// A task close that kept its folder (#2388) says where. Every locale owns
// the line, so none falls back to English.
import { describe, expect, it } from 'vitest';
import { LOCALE_OPTIONS, type Locale } from '../index';
import { ar } from '../locales/ar';
import { bs } from '../locales/bs';
import { da } from '../locales/da';
import { de } from '../locales/de';
import { en } from '../locales/en';
import { es } from '../locales/es';
import { fr } from '../locales/fr';
import { hi } from '../locales/hi';
import { id } from '../locales/id';
import { it as italian } from '../locales/it';
import { ja } from '../locales/ja';
import { ko } from '../locales/ko';
import { ms } from '../locales/ms';
import { nb } from '../locales/nb';
import { pl } from '../locales/pl';
import { ptBR } from '../locales/pt-BR';
import { ru } from '../locales/ru';
import { th } from '../locales/th';
import { tr } from '../locales/tr';
import { uk } from '../locales/uk';
import { vi } from '../locales/vi';
import { zhTW } from '../locales/zh-TW';
import { zh } from '../locales/zh';

const KEYS = ['worktask.keepFolder.done'] as const;

const LOCALE_TRANSLATIONS = {
  en,
  ko,
  ja,
  zh,
  'zh-TW': zhTW,
  ar,
  bs,
  da,
  de,
  es,
  fr,
  hi,
  id,
  it: italian,
  ms,
  nb,
  pl,
  'pt-BR': ptBR,
  ru,
  th,
  tr,
  uk,
  vi,
} satisfies Record<Locale, Partial<Record<(typeof KEYS)[number], string>>>;

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

describe('kept folder locale contract', () => {
  for (const { value: locale } of LOCALE_OPTIONS) {
    for (const key of KEYS) {
      it(`${locale}: owns "${key}"`, () => {
        const translations = LOCALE_TRANSLATIONS[locale] as Record<string, string | undefined>;
        expect(Object.prototype.hasOwnProperty.call(translations, key), `${locale} falls back for "${key}"`).toBe(true);
        const copy = translations[key] ?? '';
        expect(copy.trim().length > 0 && copy !== key).toBe(true);
        // The kept path is named.
        expect(copy).toContain('{path}');
        if (locale !== 'ko') expect(HANGUL.test(copy), `${locale} "${key}" carries Hangul`).toBe(false);
      });
    }
  }
});
