import { calendarDate, clockTime, dateTime, duration, number, money } from '../format';
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
export function seriesFormat(series: ChartSeries | string): NonNullable<ChartSeries['format']> {
  return typeof series === 'string'
    ? { kind: series === 'utilization' ? ('percent' as const) : ('gpu' as const) }
    : (series.format ?? seriesFormat(series.id));
}
export function seriesScope(series: ChartSeries) {
  return (
    series.scope ??
    t(seriesFormat(series).kind === 'percent' ? 'chart.measuredScope' : 'chart.mineScope')
  );
}
function figure(value: number | null, lower: boolean, series: ChartSeries | string) {
  if (value === null) return '—';
  // Round bounds down explicitly, including on older WebKit without roundingMode.
  const format = seriesFormat(series);
  if (format.kind === 'money')
    return `${lower ? '≥ ' : ''}${money(value, format.currency ?? 'XXX', lower)}`;
  const unit =
    format.kind === 'percent'
      ? '%'
      : t(format.kind === 'gpu_hours' ? 'chart.gpuHoursUnit' : 'chart.gpuUnit');
  return `${lower ? '≥ ' : ''}${number(lower ? Math.floor(value * 10) / 10 : value, { maximumFractionDigits: 1 })} ${unit}`;
}
export function statistics(bucket: Bucket, id: ChartSeries | string) {
  return t('chart.statistics', {
    min: figure(bucket.min, bucket.lower_bound, id),
    mean: figure(bucket.value, bucket.lower_bound, id),
    max: figure(bucket.max, bucket.lower_bound, id),
    samples: bucket.samples,
    expected: bucket.expected_samples ?? '—',
  });
}
export function reading(bucket: Bucket, id: ChartSeries | string) {
  const value =
    bucket.value === null
      ? `— ${formatMessage(bucket.gap_reason)}`
      : figure(bucket.value, bucket.lower_bound, id);
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

/** Keep server-computed summaries numeric on the wire and localize their units here. */
export function summaryText(series: ChartSeries) {
  const summary = series.summary;
  return formatMessage({
    ...summary,
    ...Object.fromEntries(
      ['mean', 'min', 'max'].map((key) => [
        key,
        figure(
          typeof summary[key] === 'number' ? summary[key] : null,
          summary.lower_bound === true,
          series,
        ),
      ]),
    ),
    duration: duration(Number(summary.minutes) * 60),
  });
}
