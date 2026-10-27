import { describe, expect, it } from 'vitest';
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

const KEYS = [
  'claudeIntegration.scheduledRetry',
  'claudeIntegration.scheduledRetryDesc',
  'schedules.retryTransient',
  'schedules.retryTransientHint',
  'schedules.state.retryWaiting',
  'schedules.reason.agent_error_retried_once',
  'schedules.reason.agent_error_retry_blocked',
  'schedules.reason.agent_error_retry_interrupted',
] as const;

const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('scheduled-run retry strings', () => {
  const locales = { ar, bs, da, de, es, fr, hi, id, it: italian, ja, ko, ms, nb, pl, ptBR, ru, th, tr, uk, vi, zhTW, zh };
  for (const [name, table] of Object.entries(locales)) {
    it(`${name} has every key with the English placeholders`, () => {
      const messages = table as Record<string, string>;
      for (const key of KEYS) {
        expect(messages[key], key).toBeTruthy();
        expect(placeholders(messages[key]), key).toEqual(placeholders(en[key]));
      }
    });
  }
});
