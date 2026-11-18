import { locale, t } from './i18n';
import { setClockFormat } from './ui/clock';

export type Clock = '24' | '12';
let currentClock: Clock = '24';
export function readClock(): Clock {
  try {
    if (localStorage.getItem('computedeck.clock') === '12') return '12';
  } catch {
    return currentClock;
  }
  return '24';
}
currentClock = readClock();
setClockFormat(currentClock);
export function saveClock(value: Clock) {
  currentClock = value;
  setClockFormat(value);
  try {
    localStorage.setItem('computedeck.clock', value);
  } catch {
    /* Keep rendering without device storage. */
  }
}
const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();
function dateFormatter(options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([locale(), options]);
  if (!dates.has(key)) dates.set(key, new Intl.DateTimeFormat(locale(), options));
  return dates.get(key)!;
}
/** Shared local date/time formatting, including chart ticks and Activity day headings. */
export function formatDate(value: Date | number, options: Intl.DateTimeFormatOptions) {
  return dateFormatter({ hour12: currentClock === '12', ...options }).format(value);
}
export function number(value: number, options: Intl.NumberFormatOptions = {}) {
  const key = JSON.stringify([locale(), options]);
  if (!numbers.has(key)) numbers.set(key, new Intl.NumberFormat(locale(), options));
  return numbers.get(key)!.format(value);
}
export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return t('time.never');
  const delta = Date.parse(value) - now;
  if (delta > 0) {
    const minutes = Math.max(1, Math.floor(delta / 60000));
    if (minutes < 60) return t('time.inMinutes', { count: minutes });
    if (minutes < 1440) return t('time.inHours', { count: Math.floor(minutes / 60) });
    return t('time.inDays', { count: Math.floor(minutes / 1440) });
  }
  const minutes = Math.max(0, Math.floor(-delta / 60000));
  if (!Number.isFinite(minutes)) return t('time.unknown');
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  if (minutes < 1440) return t('time.hoursAgo', { count: Math.floor(minutes / 60) });
  return t('time.daysAgo', { count: Math.floor(minutes / 1440) });
}
export function dateTime(value: string | null | undefined) {
  if (!value) return '—';
  return Number.isFinite(Date.parse(value))
    ? dateFormatter({
        hour12: currentClock === '12',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : value;
}
export function calendarDate(value: Date) {
  return dateFormatter({ dateStyle: 'short' }).format(value);
}
export function clockTime(value: number) {
  return dateFormatter({ hour12: currentClock === '12', timeStyle: 'short' }).format(value);
}
export function absoluteTime(value: string) {
  return dateFormatter({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: currentClock === '12',
    timeZoneName: 'long',
  }).format(new Date(value));
}
export function money(value: number | null, currency: string, lowerBound = false) {
  if (value === null) return t('money.unknown');
  if (lowerBound) value += 1e-9 * Math.max(1, Math.abs(value));
  try {
    return number(value, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      roundingMode: lowerBound ? 'floor' : 'halfExpand',
    });
  } catch {
    return `${currency} ${number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false, roundingMode: lowerBound ? 'floor' : 'halfExpand' })}`;
  }
}

export function duration(seconds: number, style: 'table' | 'prose' = 'prose') {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  if (style === 'table')
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
  if (whole < 60) return t('cost.duration.seconds', { count: whole });
  if (whole >= 86400)
    return [
      t('cost.duration.days', { count: Math.floor(whole / 86400) }),
      hours % 24 ? t('cost.duration.hours', { count: hours % 24 }) : '',
    ]
      .filter(Boolean)
      .join(' ');
  return [
    hours ? t('cost.duration.hours', { count: hours }) : '',
    minutes || !hours ? t('cost.duration.minutes', { count: minutes }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function percentage(value: number | null | undefined) {
  return value == null ? '—' : `${Math.round(value)}%`;
}
/** Compact elapsed time, rounded down: minutes below an hour, otherwise days and hours. */
export function runDuration(hours: number) {
  const minutes = Math.floor(hours * 60);
  if (minutes < 60) return t('cost.duration.minutes', { count: minutes });
  const days = Math.floor(minutes / 1440);
  const remainingHours = Math.floor(minutes / 60) % 24;
  return [
    days ? t('cost.duration.days', { count: days }) : '',
    remainingHours ? t('cost.duration.hours', { count: remainingHours }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
