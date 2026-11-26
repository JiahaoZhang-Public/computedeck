// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from './i18n';
import {
  absoluteTime,
  calendarDate,
  clockTime,
  dateTime,
  duration,
  money,
  number,
  readClock,
  relativeTime,
  saveClock,
} from './format';

afterEach(() => {
  setLocale('en');
  saveClock('24');
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe.each(['en', 'zh-CN'] as const)('formatting %s', (language) => {
  it('formats local absolute time with a zone, and respects the clock preference', () => {
    setLocale(language);
    const date = new Date(2026, 0, 15, 14, 5, 12);
    expect(readClock()).toBe('24');
    expect(clockTime(date.getTime())).toContain('14:05');
    expect(dateTime(date.toISOString())).toContain('14:05');
    expect(absoluteTime(date.toISOString())).toContain('14:05:12');
    expect(absoluteTime(date.toISOString()).length).toBeGreaterThan(
      dateTime(date.toISOString()).length,
    );
    expect(calendarDate(date)).toBe(
      new Intl.DateTimeFormat(language, { dateStyle: 'short' }).format(date),
    );
    saveClock('12');
    expect(readClock()).toBe('12');
    expect(clockTime(date.getTime())).toContain('2:05');
  });
  it('keeps unknowns, future dates and relative boundaries honest', () => {
    setLocale(language);
    const now = Date.parse('2026-01-15T14:00:00Z');
    expect(relativeTime(null, now)).toBe(t('time.never'));
    expect(relativeTime('invalid', now)).toBe(t('time.unknown'));
    expect(relativeTime('2026-01-16T14:00:00Z', now)).toBe(t('time.inDays', { count: 1 }));
    expect(relativeTime('2026-01-15T13:59:00Z', now)).toBe(t('time.minutesAgo', { count: 1 }));
    expect(relativeTime('2026-01-15T13:00:00Z', now)).toBe(t('time.hoursAgo', { count: 1 }));
    expect(relativeTime('2026-01-14T14:00:00Z', now)).toBe(t('time.daysAgo', { count: 1 }));
    expect(dateTime(null)).toBe('—');
    expect(dateTime('invalid')).toBe('invalid');
  });
  it('formats durations without DurationFormat, including long table durations', () => {
    setLocale(language);
    vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { DurationFormat: undefined }));
    expect(duration(11560, 'table')).toBe('3:12:40');
    expect(duration(27 * 3600, 'table')).toBe('27:00:00');
    expect(duration(11400)).toBe(
      `${t('cost.duration.hours', { count: 3 })} ${t('cost.duration.minutes', { count: 10 })}`,
    );
    expect(duration(0)).toBe(t('cost.duration.seconds', { count: 0 }));
    expect(duration(-1)).toBe('—');
    expect(duration(NaN)).toBe('—');
  });
  it('keeps currencies separate and lower-bound rounding downward', () => {
    setLocale(language);
    expect(money(41.209, 'USD', true)).toBe(money(41.2, 'USD'));
    expect(money(41.209, 'USD')).not.toBe(money(41.2, 'USD'));
    expect(money(null, 'USD')).toBe(t('money.unknown'));
    expect(money(41.2, 'invalid')).toBe('invalid 41.20');
    expect(number(1200)).toBe('1,200');
  });
});
it('survives blocked device storage and ignores invalid clock values', () => {
  localStorage.setItem('computedeck.clock', 'invalid');
  expect(readClock()).toBe('24');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => saveClock('12')).not.toThrow();
  expect(readClock()).toBe('12');
});

describe.each(['en', 'zh-CN'] as const)('duration boundaries in %s', (language) => {
  it.each([true, false])(
    'uses the same localized spelling with DurationFormat present: %s',
    (present) => {
      setLocale(language);
      const Constructor = vi.fn(() => {
        throw new Error('native duration spelling must not be used');
      });
      vi.stubGlobal(
        'Intl',
        Object.assign(Object.create(Intl), {
          DurationFormat: present ? Constructor : undefined,
        }),
      );
      expect([0, 59, 60, 11520].map((seconds) => duration(seconds))).toEqual(
        language === 'en'
          ? ['0 s', '59 s', '1 min', '3 h 12 min']
          : ['0 秒', '59 秒', '1 分钟', '3 小时 12 分钟'],
      );
      expect(Constructor).not.toHaveBeenCalled();
    },
  );
});

it.each(['en', 'zh-CN'] as const)(
  'formats future retries and short/long ages in %s',
  (language) => {
    setLocale(language);
    const now = Date.parse('2026-01-15T14:00:00Z');
    expect(relativeTime('2026-01-15T14:15:00Z', now)).toBe(t('time.inMinutes', { count: 15 }));
    expect(relativeTime('2026-01-15T16:00:00Z', now)).toBe(t('time.inHours', { count: 2 }));
    expect(duration(40)).toBe(t('cost.duration.seconds', { count: 40 }));
    expect(duration(3 * 86400)).toBe(t('cost.duration.days', { count: 3 }));
  },
);
