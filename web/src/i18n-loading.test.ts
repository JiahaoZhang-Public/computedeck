import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.resetModules());

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
