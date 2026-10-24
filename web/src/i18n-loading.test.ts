// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each(['en', 'zh-CN'] as const)('loads only the selected %s dictionary', async (language) => {
  vi.resetModules();
  const { loadLocale, localeLoaded, setLocale, t, hasKey, locale } = await import('./i18n');
  const other = language === 'en' ? 'zh-CN' : 'en';
  expect(localeLoaded(language)).toBe(false);
  expect(localeLoaded(other)).toBe(false);
  const first = loadLocale(language);
  expect(loadLocale(language)).toBe(first);
  await first;
  setLocale(language);
  expect(locale()).toBe(language);
  expect(t('nav.jobs')).toBe(language === 'en' ? 'Jobs' : '作业');
  expect(hasKey('nav.jobs')).toBe(true);
  expect(hasKey('not-a-message')).toBe(false);
  expect(localeLoaded(other)).toBe(false);
  await loadLocale(other);
  setLocale(other);
  expect(t('nav.jobs')).toBe(other === 'en' ? 'Jobs' : '作业');
  await loadLocale(language);
  setLocale(language);
  expect(locale()).toBe(language);
});

it('loads only the remembered server language on a later cold start without a device choice', async () => {
  const first = await import('./i18n');
  first.rememberServerLocale('zh-CN');
  vi.resetModules();
  const cold = await import('./i18n');
  expect(cold.storedLocale()).toBeNull();
  expect(cold.startupLocale()).toBe('zh-CN');
  await cold.loadLocale(cold.startupLocale());
  expect(cold.localeLoaded('zh-CN')).toBe(true);
  expect(cold.localeLoaded('en')).toBe(false);
});

it('gives the device choice precedence over the remembered server language', async () => {
  const { rememberServerLocale, storeLocale, startupLocale } = await import('./i18n');
  rememberServerLocale('zh-CN');
  storeLocale('en');
  expect(startupLocale()).toBe('en');
});

it('ignores invalid hints and works when storage is blocked', async () => {
  const { rememberServerLocale, rememberedServerLocale, startupLocale } = await import('./i18n');
  window.localStorage.setItem('computedeck.serverLocale', 'invalid');
  expect(rememberedServerLocale()).toBeNull();
  expect(startupLocale()).toBe('en');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => rememberServerLocale('zh-CN')).not.toThrow();
  expect(startupLocale()).toBe('en');
});
