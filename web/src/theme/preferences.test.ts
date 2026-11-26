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
  THEME_EVENT,
} from './preferences';

// Execute the actual head bootstrap, independently of the application module.
const bootstrap = () => new Function(html.match(/<script>([\s\S]*?)<\/script>/)![1])();

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
it.each(['light', 'dark'] as const)('bootstraps %s and compact before the bundle runs', (theme) => {
  localStorage.setItem('computedeck.theme', theme);
  localStorage.setItem('computedeck.density', 'compact');
  bootstrap();
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(document.documentElement.dataset.density).toBe('compact');
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    expect(meta.media).toBe(meta.dataset.theme === theme ? 'all' : 'not all');
  const before = document.documentElement.outerHTML;
  initializeAppearance();
  expect(document.documentElement.outerHTML).toBe(before);
});
it.each([null, 'system', 'invalid'])('bootstraps default appearance for %s', (saved) => {
  if (saved !== null) {
    localStorage.setItem('computedeck.theme', saved);
    localStorage.setItem('computedeck.density', saved);
  }
  bootstrap();
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(document.documentElement.dataset.density).toBe('comfortable');
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    expect(meta.getAttribute('media')).toBe(`(prefers-color-scheme: ${meta.dataset.theme})`);
});
it('head bootstrap tolerates blocked storage', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(bootstrap).not.toThrow();
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  initializeAppearance();
  expect(document.documentElement.dataset.density).toBe('comfortable');
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
it('tells every control that shows the theme when it changes', () => {
  const changed = vi.fn();
  window.addEventListener(THEME_EVENT, changed);
  try {
    saveTheme('dark');
    expect(changed).toHaveBeenCalledOnce();
    expect(readTheme()).toBe('dark');
    saveTheme('system');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  } finally {
    window.removeEventListener(THEME_EVENT, changed);
  }
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
