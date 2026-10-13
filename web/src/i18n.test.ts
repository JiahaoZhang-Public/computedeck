import { afterEach, describe, expect, it } from 'vitest';
import en from './locales/en';
import zhCN from './locales/zh-CN';
import { ApiError, errorText, formatMessage, setLocale, t } from './i18n';
import { statusLabel } from './labels';

afterEach(() => setLocale('en'));

describe('translations', () => {
  it('defines the same keys and placeholders in every language', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[])
      expect([key, placeholders(zhCN[key])]).toEqual([key, placeholders(en[key])]);
  });
  it('defaults to English and switches without reloading', () => {
    expect(t('nav.jobs')).toBe('Jobs');
    expect(t('time.minutesAgo', { count: 3 })).toBe('3 min ago');
    expect(t('overview.instances', { count: 1 })).toBe('1 instance');
    expect(t('overview.instances', { count: 2 })).toBe('2 instances');
    setLocale('zh-CN');
    expect(t('nav.jobs')).toBe('作业');
    expect(statusLabel('PENDING')).toBe('排队中');
    expect(statusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
  it('spaces Latin names and numbers from Chinese text', () => {
    setLocale('zh-CN');
    expect(t('market.installNote', { where: 'gpu-box' })).toContain('需要在 gpu-box 上用');
    expect(t('market.installNote', { where: '本机' })).toContain('需要在本机上用');
    expect(t('toolbox.turnedOn', { name: '任务提醒' })).toBe('已开启任务提醒');
  });
  it('renders server messages with parameters and keeps untranslated remote detail', () => {
    expect(formatMessage({ code: 'http_status', status: 401 })).toBe('The API returned HTTP 401');
    expect(formatMessage({ code: 'ssh_failed', detail: 'Permission denied' })).toBe(
      'SSH failed: Permission denied',
    );
    expect(formatMessage({ code: 'brand_new_code' })).toBe('brand_new_code');
    expect(formatMessage('plain text')).toBe('plain text');
    expect(formatMessage(null)).toBe('');
  });
  it('turns API errors into readable text', () => {
    expect(errorText(new ApiError(404, { code: 'source_not_found' }), 'error.save')).toBe(
      'Source not found',
    );
    expect(errorText(new ApiError(500, null), 'error.save')).toBe('Request failed (HTTP 500)');
    expect(errorText('nonsense', 'error.save')).toBe('Could not save');
  });
});
