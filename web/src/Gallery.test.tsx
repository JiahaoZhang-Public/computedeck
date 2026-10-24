// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Gallery } from './Gallery';
import { setLocale, t } from './i18n';

const container = document.createElement('div');
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  setLocale('en');
  vi.unstubAllGlobals();
});

it.each(['en', 'zh-CN'] as const)(
  'shows and exercises the public components in %s',
  async (locale) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setLocale(locale);
    await act(async () => root.render(<Gallery compat={false} />));
    expect(container.textContent).toContain(t('gallery.components'));
    expect(container.querySelectorAll('.status')).toHaveLength(6);
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]');
    await act(async () => tabs[1].click());
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    const toggle = container.querySelector<HTMLInputElement>('[role=switch]')!;
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'covers every frozen CSS class and token in %s',
  async (locale) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setLocale(locale);
    await act(async () => root.render(<Gallery compat />));
    for (const name of [
      'panel',
      'panel-header',
      'panel-note',
      'button',
      'primary-button',
      'secondary-button',
      'primary',
      'form-error',
      'num',
      'spin',
      'status.green',
      'status.amber',
      'status.red',
      'table-wrap',
      'table',
      'compact',
      'sub',
      'muted',
      'red-text',
      'red',
      'amber',
      'link',
      'banner.amber',
    ])
      expect(container.querySelector(`.${name}`), name).not.toBeNull();
    expect(container.querySelectorAll('[data-token]')).toHaveLength(21);
    expect(container.textContent).toContain(t('gallery.classes'));
    expect(container.querySelectorAll('input,select,a')).toHaveLength(6);
  },
);
