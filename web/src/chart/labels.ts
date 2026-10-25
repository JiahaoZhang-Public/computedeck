import { calendarDate, clockTime, dateTime, number } from '../format';
import { formatMessage, t } from '../i18n';
import type { Bucket, ChartSeries } from './types';

export function compactTime(at: string, now = Date.now()) {
  return calendarDate(new Date(at)) === calendarDate(new Date(now))
    ? clockTime(Date.parse(at))
    : dateTime(at);
}
export function intervalEnd(start: string, end: string) {
  return calendarDate(new Date(start)) === calendarDate(new Date(end))
    ? clockTime(Date.parse(end))
    : dateTime(end);
}
export function compactRange(start: string, end: string, now = Date.now()) {
  const spansDays = calendarDate(new Date(start)) !== calendarDate(new Date(end));
  return `${spansDays ? dateTime(start) : compactTime(start, now)} – ${intervalEnd(start, end)}`;
}

export function seriesLabel(series: ChartSeries) {
  return series.label ?? t(series.id === 'utilization' ? 'chart.utilization' : 'chart.allocated');
}
function figure(value: number | null, lower: boolean) {
  if (value === null) return '—';
  // Round bounds down explicitly, including on older WebKit without roundingMode.
  return `${lower ? '≥ ' : ''}${number(lower ? Math.floor(value * 10) / 10 : value, { maximumFractionDigits: 1 })}`;
}
export function statistics(bucket: Bucket) {
  return t('chart.statistics', {
    min: figure(bucket.min, bucket.lower_bound),
    mean: figure(bucket.value, bucket.lower_bound),
    max: figure(bucket.max, bucket.lower_bound),
    samples: bucket.samples,
    expected: bucket.expected_samples ?? '—',
  });
}
export function reading(bucket: Bucket) {
  const value =
    bucket.value === null
      ? `— ${formatMessage(bucket.gap_reason)}`
      : figure(bucket.value, bucket.lower_bound);
  const sources =
    bucket.known_sources === null
      ? t('chart.coverageUnknown')
      : t('chart.sources', { known: bucket.known_sources, total: bucket.total_sources! });
  return [
    value,
    sources,
    bucket.partial ? t('chart.partialData') : '',
    bucket.so_far ? t('chart.soFar') : '',
    bucket.held_from ? t('chart.held', { time: compactTime(bucket.held_from) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
