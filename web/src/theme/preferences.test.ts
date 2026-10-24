// @vitest-environment jsdom
import html from '../../index.html?raw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tokens } from './tokens';
import { linearRGB } from './color';
import {
  initializeAppearance,
  readTheme,
  readDensity,
  saveTheme,
  saveDensity,
} from './preferences';

beforeEach(() => {
  document.head.innerHTML = html.match(/<meta\s+name="theme-color"[^>]+>/g)!.join('');
});

afterEach(() => {
  document.head.innerHTML = '';
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

it('uses canvas colours for browser chrome and honours explicit themes over the OS', () => {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  expect(metas).toHaveLength(2);
  for (const theme of ['light', 'dark'] as const) {
    const hex =
      '#' +
      linearRGB(tokens['bg-canvas'][theme])
        .map((value) => {
          const srgb = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
          return Math.round(srgb * 255)
            .toString(16)
            .padStart(2, '0');
        })
        .join('');
    expect(metas.find((meta) => meta.dataset.theme === theme)?.content).toBe(hex);
    saveTheme(theme);
    for (const meta of metas)
      expect(meta.media).toBe(meta.dataset.theme === theme ? 'all' : 'not all');
    initializeAppearance();
    expect(metas.find((meta) => meta.media === 'all')?.dataset.theme).toBe(theme);
  }
  saveTheme('system');
  for (const meta of metas)
    expect(meta.media).toBe(`(prefers-color-scheme: ${meta.dataset.theme})`);
});
