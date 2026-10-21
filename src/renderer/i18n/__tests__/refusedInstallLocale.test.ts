// The re-hash refusal notices tell the user to check for updates again. In
// Settings that check is one-shot: once the fresh installer verifies, it
// installs and wmux quits, closing every pane. The notice has to say so, the
// same way the ready-to-install notice does (`settings.updateEndsSessions`),
// in every locale that carries these strings.
import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';

const LOCALES = { en, ko, zh, pl } as Record<string, Record<string, string>>;
const KEYS = ['update.refusedInstallChanged', 'update.refusedInstallUnreadable'];

describe('refused-install notices that send the user to check for updates', () => {
  for (const [locale, strings] of Object.entries(LOCALES)) {
    for (const key of KEYS) {
      it(`${locale} ${key} warns that installing closes every pane`, () => {
        const warning = strings['settings.updateEndsSessions'];
        expect(warning).toBeTruthy();
        expect(strings[key].endsWith(warning)).toBe(true);
      });
    }
  }
});
