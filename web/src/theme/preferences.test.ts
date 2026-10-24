// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  initializeAppearance,
  readTheme,
  readDensity,
  saveTheme,
  saveDensity,
} from './preferences';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
});
it('defaults to system and comfortable and ignores invalid saved choices', () => {
  localStorage.setItem('computedeck.theme', 'invalid');
  localStorage.setItem('computedeck.density', 'invalid');
  initializeAppearance();
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(readTheme()).toBe('system');
  expect(readDensity()).toBe('comfortable');
});
it.each(['light', 'dark'] as const)('persists %s and restores it before rendering', (theme) => {
  saveTheme(theme);
  saveDensity('compact');
  delete document.documentElement.dataset.theme;
  initializeAppearance();
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(document.documentElement.dataset.density).toBe('compact');
  expect(readTheme()).toBe(theme);
  saveTheme('system');
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(localStorage.getItem('computedeck.theme')).toBe('system');
});
it('still applies choices when device storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => initializeAppearance()).not.toThrow();
  expect(() => saveTheme('dark')).not.toThrow();
  expect(() => saveDensity('compact')).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.density).toBe('compact');
});
