// @vitest-environment jsdom
//
// Only English ships in the renderer bundle; every other locale's table loads
// when a window first needs it. A language switch waits for its table, so the
// UI never shows English or raw keys in between.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';

const KEY = 'connectors.access.title';

async function freshModules() {
  vi.resetModules();
  const i18n = await import('../index');
  const { useStore } = await import('../../stores');
  return { i18n, useStore };
}

describe('lazy locale tables', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('starts with only English in, and reads another language once its table loads', async () => {
    const { i18n } = await freshModules();
    expect(i18n.LOCALE_OPTIONS.filter((o) => i18n.isLocaleLoaded(o.value)).map((o) => o.value)).toEqual(['en']);

    i18n.setLocale('ko');
    expect(i18n.t(KEY)).toBe(en[KEY]);
    await i18n.loadLocale('ko');
    expect(i18n.isLocaleLoaded('ko')).toBe(true);
    expect(i18n.t(KEY)).toBe(ko[KEY]);
  });

  it('switches the store once the table is in, and a later pick wins over one still loading', async () => {
    const { i18n, useStore } = await freshModules();

    useStore.getState().setLocale('ko');
    // Not switched yet: still all English, store and copy alike.
    expect(useStore.getState().locale).toBe('en');
    expect(i18n.getLocale()).toBe('en');
    await vi.waitFor(() => expect(useStore.getState().locale).toBe('ko'), { timeout: 5_000 });
    expect(i18n.t(KEY)).toBe(ko[KEY]);

    // Japanese is still loading when English is picked: English stays.
    useStore.getState().setLocale('ja');
    useStore.getState().setLocale('en');
    expect(useStore.getState().locale).toBe('en');
    await i18n.loadLocale('ja');
    await Promise.resolve();
    expect(useStore.getState().locale).toBe('en');
    expect(i18n.getLocale()).toBe('en');
  });

  it("starts a window in the language on screen before a reload, else main's, else English", async () => {
    const { i18n } = await freshModules();
    expect(i18n.resolveStartLocale('ja', 'ko')).toBe('ja');
    expect(i18n.resolveStartLocale(null, 'ko')).toBe('ko');
    expect(i18n.resolveStartLocale('xx', 'pt-BR')).toBe('pt-BR');
    expect(i18n.resolveStartLocale(null, 'xx')).toBe('en');
    expect(i18n.resolveStartLocale(undefined, null)).toBe('en');

    i18n.setLocale('de');
    expect(window.sessionStorage.getItem(i18n.START_LOCALE_STORAGE_KEY)).toBe('de');
  });
});
