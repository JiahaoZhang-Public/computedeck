// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { LocaleGate } from './app/LocaleGate';
import * as i18n from './i18n';
import { api } from './api';
import { serverDemo } from './test-server';

vi.mock('./api', () => ({ api: vi.fn(), upload: vi.fn(), download: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?demo=true#/settings');
  window.localStorage.clear();
  i18n.setLocale('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});
async function render(element: ReactNode) {
  await act(async () => root.render(<StrictMode>{element}</StrictMode>));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}
async function choose(language: i18n.Locale) {
  const select = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${i18n.t('settings.language')}"]`,
  );
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = language;
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function mockDashboard(settings: Promise<unknown> = Promise.resolve({ language: 'en' })) {
  const data = serverDemo();
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return settings;
      if (path === '/health') return null;
      return [];
    });
}

it.each(['en', 'zh-CN'] as const)(
  'keeps startup in %s while loading, and allows retry after failure',
  async (language) => {
    window.localStorage.setItem('computedeck.locale', language);
    vi.spyOn(i18n, 'localeLoaded').mockReturnValue(false);
    const first = deferred<void>();
    const next = deferred<void>();
    const load = vi.spyOn(i18n, 'loadLocale').mockReturnValue(first.promise);
    await render(<LocaleGate>{() => <main>Ready</main>}</LocaleGate>);
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')?.getAttribute('lang')).toBe(language);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      language === 'en' ? 'Loading…' : '正在载入…',
    );
    expect(load).toHaveBeenCalledWith(language);
    await act(async () => first.reject(new Error('offline')));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      language === 'en' ? 'Could not load the language. Try again.' : '无法加载语言，请重试。',
    );
    load.mockReturnValue(next.promise);
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => next.resolve());
    expect(container.querySelector('main')?.textContent).toBe('Ready');
  },
);

it.each([
  ['computedeck.locale', 'en'],
  ['computedeck.locale', 'zh-CN'],
  ['computedeck.serverLocale', 'en'],
  ['computedeck.serverLocale', 'zh-CN'],
] as const)('uses the loaded language when %s changes while %s loads', async (key, language) => {
  mockDashboard(deferred<unknown>().promise);
  window.localStorage.setItem(key, language);
  vi.spyOn(i18n, 'localeLoaded').mockReturnValue(false);
  const pending = deferred<void>();
  const load = vi.spyOn(i18n, 'loadLocale').mockReturnValue(pending.promise);
  const select = vi.spyOn(i18n, 'setLocale');
  await render(<App />);
  expect(container.querySelector('main')).toBeNull();
  expect(load).toHaveBeenCalledWith(language);
  const next = language === 'en' ? 'zh-CN' : 'en';
  window.localStorage.setItem(key, next);
  await act(async () => pending.resolve());
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(document.documentElement.lang).toBe(language);
  expect(container.querySelector('h1')?.textContent).toBe(language === 'en' ? 'Settings' : '设置');
  expect(select).toHaveBeenCalledWith(language);
  expect(select).not.toHaveBeenCalledWith(next);
  expect(window.localStorage.getItem(key)).toBe(next);
});

it('keeps the active language and device preference when another dictionary fails', async () => {
  mockDashboard();
  window.localStorage.setItem('computedeck.locale', 'en');
  await render(<App />);
  const pending = deferred<void>();
  vi.spyOn(i18n, 'loadLocale').mockReturnValue(pending.promise);
  await choose('zh-CN');
  expect(document.documentElement.lang).toBe('en');
  expect(container.querySelector('h1')?.textContent).toBe('Settings');
  const language = container.querySelector<HTMLSelectElement>('select[aria-label="Language"]')!;
  expect(language.value).toBe('zh-CN');
  expect(language.getAttribute('aria-busy')).toBe('true');
  await act(async () => pending.reject(new Error('offline')));
  expect(language.value).toBe('en');
  expect(language.getAttribute('aria-busy')).toBe('false');
  expect(document.documentElement.lang).toBe('en');
  expect(window.localStorage.getItem('computedeck.locale')).toBe('en');
  expect(container.querySelector('.toasts[role="status"] .toast.error')?.textContent).toContain(
    i18n.t('error.locale'),
  );
});

it('lets the newest device selection win over a slower dictionary load', async () => {
  mockDashboard();
  window.localStorage.setItem('computedeck.locale', 'en');
  await render(<App />);
  const pending = deferred<void>();
  vi.spyOn(i18n, 'loadLocale').mockImplementation((language) =>
    language === 'zh-CN' ? pending.promise : Promise.resolve(),
  );
  await choose('zh-CN');
  await choose('en');
  await act(async () => pending.resolve());
  expect(document.documentElement.lang).toBe('en');
  expect(container.querySelector('h1')?.textContent).toBe('Settings');
  expect(window.localStorage.getItem('computedeck.locale')).toBe('en');
});

it('does not let a late server preference replace a device selection', async () => {
  const settings = deferred<unknown>();
  mockDashboard(settings.promise);
  await render(<App />);
  await choose('zh-CN');
  await act(async () => settings.resolve({ language: 'en' }));
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(container.querySelector('h1')?.textContent).toBe('设置');
  expect(window.localStorage.getItem('computedeck.locale')).toBe('zh-CN');
});

it('remembers the server language for startup, then follows a changed server default', async () => {
  mockDashboard(Promise.resolve({ language: 'zh-CN' }));
  await render(<App />);
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(i18n.rememberedServerLocale()).toBe('zh-CN');
  expect(i18n.storedLocale()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  const settings = deferred<unknown>();
  mockDashboard(settings.promise);
  const load = vi.spyOn(i18n, 'loadLocale');
  await render(<App />);
  expect(container.querySelector('h1')?.textContent).toBe('设置');
  expect(load.mock.calls.every(([language]) => language === 'zh-CN')).toBe(true);
  expect(load).toHaveBeenCalledWith('zh-CN');
  await act(async () => settings.resolve({ language: 'en' }));
  expect(container.querySelector('h1')?.textContent).toBe('Settings');
  expect(i18n.rememberedServerLocale()).toBe('en');
  expect(i18n.storedLocale()).toBeNull();
});

it.each(['en', 'zh-CN'] as const)(
  'shows a named, recoverable error for a failed lazy form in %s',
  async (language) => {
    i18n.setLocale(language);
    const { lazyView } = await import('./app/lazyView');
    const { Suspense } = await import('react');
    const Form = lazyView(async () => {
      throw new Error('offline');
    }, 'modal-title');
    await render(
      <div role="dialog" aria-labelledby="modal-title">
        <Suspense fallback="loading">
          <Form />
        </Suspense>
      </div>,
    );
    expect(container.querySelector('strong#modal-title')?.textContent).toBe(i18n.t('form.failed'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(i18n.t('error.chunk'));
    expect(container.querySelector('button')?.textContent).toBe(i18n.t('common.retry'));
  },
);
