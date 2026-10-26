// Locale contract for the usage-limit verbs outside the card: the Fleet row
// menu (FleetRowActions.tsx) still arms a held pane with its own labels. A t()
// key missing from the locale map renders as the raw key string, and tsc
// can't catch it — t()'s signature accepts any string. Keep this list in sync
// with the usageLimit.* keys FleetRowActions uses.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { loadLocale, t, setLocale, type Locale } from '../index';

const KEYS = [
  'usageLimit.resumeAtReset',
  'usageLimit.resumingAtReset',
  'usageLimit.resumeAtResetTitle',
  'usageLimit.cancelResumeTitle',
] as const;

const LOCALES: Locale[] = ['en', 'ko', 'pl'];

// Tables other than English load on demand; the tests below read Korean and Polish synchronously.
beforeAll(() => Promise.all(LOCALES.map(loadLocale)));

describe('usageLimit Fleet row locale contract', () => {
  afterAll(() => setLocale('en'));

  for (const locale of LOCALES) {
    it(`${locale}: every Fleet row usage-limit key resolves to real copy (not the raw key)`, () => {
      setLocale(locale);
      for (const key of KEYS) {
        const s = t(key);
        expect(s, `${locale} missing "${key}"`).toBeTruthy();
        expect(s, `${locale} "${key}" renders as the raw key`).not.toBe(key);
      }
    });
  }
});
