// @vitest-environment jsdom
// Regression coverage migrated from raw points to the server-bucket chart kit.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chart } from './Chart';
import { compactRange, compactTime, reading, statistics, summaryText } from './labels';
import { chartFixture } from './test-data';
import { gapBands, segments, seriesStyles, timeX, y } from './geometry';
import { setLocale, t } from '../i18n';
import { clockTime, dateTime, duration } from '../format';
import type { HistoryPoint } from '../types';

const point = (value: number | null, extra: Partial<HistoryPoint> = {}): HistoryPoint => ({
  at: '2026-10-13T10:00:00Z',
  allocated_gpus: value,
  gpu_utilization: value,
  coverage_count: 4,
  ...extra,
});
afterEach(() => {
  vi.useRealTimers();
  setLocale('en');
});
function markup(points: HistoryPoint[]) {
  const data = chartFixture(
    points.map((p, i) => ({ ...p, at: new Date(Date.parse(p.at) + i * 300000).toISOString() })),
  );
  data.start = data.series[0].buckets[0].start;
  data.end = data.series[0].buckets.at(-1)!.end;
  data.as_of = data.end;
  const node = document.createElement('div');
  node.innerHTML = renderToStaticMarkup(<Chart data={data} />);
  return { node, data };
}
describe.each(['en', 'zh-CN'] as const)('chart honesty %s', (locale) => {
  it('separates the utilization unit and leaves the allocation label unchanged', () => {
    setLocale(locale);
    const { node } = markup([point(4)]);
    expect(
      [...node.querySelectorAll('.chart-multiple > div')].map((label) => label.textContent),
    ).toEqual(
      locale === 'en' ? ['GPU utilization · %', 'GPUs in use'] : ['GPU 利用率 · %', '在用 GPU'],
    );
  });
  it('breaks at unknown buckets and keeps isolated samples visible', () => {
    setLocale(locale);
    const { node, data } = markup([point(4), point(null), point(6), point(null), point(8)]);
    expect(segments(data.series[0].buckets).map((segment) => segment.indices)).toEqual([
      [0],
      [2],
      [4],
    ]);
    expect(node.querySelectorAll('.bucket-line')).toHaveLength(6);
    expect(node.querySelectorAll('.bucket-gap')).toHaveLength(4);
    expect(node.querySelectorAll('.bucket-dot')).toHaveLength(8);
    for (const path of node.querySelectorAll('.bucket-line'))
      expect(path.getAttribute('d')).not.toContain('L');
  });
  it('keeps the trailing outage visible instead of stretching the last reading to now', () => {
    const { node } = markup([point(4), point(null), point(null), point(null)]);
    expect(node.querySelectorAll('.bucket-gap')).toHaveLength(2);
    expect(node.querySelectorAll('.bucket-gap-label')).toHaveLength(2);
    expect(Number(node.querySelector('.bucket-dot')!.getAttribute('cx'))).toBeLessThan(200);
  });
  it('reserves dashes for lower bounds and hatches for gaps', () => {
    setLocale(locale);
    const { node, data } = markup([
      point(8),
      point(null, { known_allocated_gpus: 8, unknown_allocation_sources: 1 }),
    ]);
    const series = data.series[1];
    expect(series.buckets.map((b) => b.value)).toEqual([8, 8]);
    expect(node.querySelector('.bucket-partial')).toBeNull();
    expect(node.querySelectorAll('[data-lower-bound=false][stroke-dasharray]')).toHaveLength(0);
    expect(node.querySelector('[data-lower-bound="true"]')!.getAttribute('stroke-dasharray')).toBe(
      '3 3',
    );
    expect(reading(series.buckets[1], 'allocation')).toContain('≥ 8');
    expect(reading(series.buckets[1], 'allocation')).toContain(
      t('chart.sources', { known: 1, total: 2 }),
    );
  });
  it('shows empty reasons and unavailable coverage without inventing zero', () => {
    setLocale(locale);
    const { node, data } = markup([point(null)]);
    expect(node.querySelector('.chart-empty')).not.toBeNull();
    expect(node.querySelector('.bucket-line')).toBeNull();
    const bucket = { ...data.series[0].buckets[0], known_sources: null, total_sources: null };
    expect(reading(bucket, 'utilization')).toContain('—');
    expect(reading(bucket, 'utilization')).toContain(t('chart.coverageUnknown'));
  });
});
it('uses ink for metrics and reserves identity colours and collision markers for groups', () => {
  const series = chartFixture([point(2)]).series;
  const styles = seriesStyles(series.map((s, i) => ({ ...s, slot: 1, label: `Cluster ${i}` })));
  expect(seriesStyles(series)).toEqual([
    { color: 'var(--chart-line)', square: false },
    { color: 'var(--chart-line)', square: false },
  ]);
  expect(styles[0]).toEqual({ color: 'var(--id-1)', square: false });
  expect(styles[1]).toEqual({ color: 'var(--chart-line)', square: true });
});

it('maps clipped bucket edges to elapsed time, not equal column widths', async () => {
  const { timeX } = await import('./geometry');
  expect(timeX(0, 0, 24)).toBe(36);
  expect(timeX(24, 0, 24)).toBe(752);
  expect(timeX(6, 0, 24) - 36).toBe((752 - 36) / 4);
});

it('merges only adjacent gaps with the same reason and continues through held bins', () => {
  const { data } = markup([point(null), point(null), point(null), point(8), point(8)]);
  const buckets = data.series[0].buckets;
  buckets[2].gap_reason = { code: 'chart_not_collecting' };
  buckets[4].samples = 0;
  buckets[4].held_from = buckets[3].start;
  expect(gapBands(buckets)).toEqual([
    { start: buckets[0].start, end: buckets[1].end, reason: { code: 'chart_unknown' } },
    { start: buckets[2].start, end: buckets[2].end, reason: { code: 'chart_not_collecting' } },
  ]);
  expect(segments(buckets).map((segment) => segment.indices)).toEqual([[3, 4]]);
});

describe.each(['en', 'zh-CN'] as const)('compact chart time %s', (locale) => {
  it('uses local short times, dates only when needed, and labels held readings', () => {
    setLocale(locale);
    vi.useFakeTimers();
    const now = '2026-01-15T14:00:00Z',
      start = '2026-01-15T13:55:00Z';
    vi.setSystemTime(new Date(now));
    expect(compactRange(start, now)).toBe(
      `${clockTime(Date.parse(start))} – ${clockTime(Date.parse(now))}`,
    );
    const yesterday = '2026-01-14T13:55:00Z';
    expect(compactTime(yesterday)).toBe(dateTime(yesterday));
    expect(compactRange(yesterday, now)).toBe(`${dateTime(yesterday)} – ${dateTime(now)}`);
    const bucket = chartFixture([point(8)]).series[0].buckets[0];
    expect(reading({ ...bucket, held_from: start, samples: 0 }, 'utilization')).toContain(
      t('chart.held', { time: clockTime(Date.parse(start)) }),
    );
  });
});

describe.each(['en', 'zh-CN'] as const)('chart units and bounds %s', (locale) => {
  it('puts units beside values in summaries, readings, statistics and tables', () => {
    setLocale(locale);
    const { data, node } = markup([point(60.9)]);
    const util = data.series[0];
    expect(reading(util.buckets[0], util.id)).toContain('60.9 %');
    expect(statistics(util.buckets[0], util.id)).toContain('60.9 %');
    expect(node.querySelector('.chart-readout')!.textContent).toContain('60.9 %');
    util.summary = {
      code: 'chart_summary',
      mean: 60.9,
      min: 44.333333333,
      max: 80,
      gaps: 23,
      minutes: 115,
      partial: 0,
    };
    const text = summaryText(util);
    expect(text).toContain('60.9 %');
    expect(text).toContain('44.3 %');
    expect(text).toContain(duration(115 * 60));
    const allocation = data.series[1];
    allocation.summary = { ...util.summary, lower_bound: true, mean: 19.99 };
    expect(summaryText(allocation)).toContain(`≥ 19.9 ${t('chart.gpuUnit')}`);
    expect(summaryText(allocation).match(/≥/g)).toHaveLength(3);
    util.summary = {
      code: 'chart_empty_summary',
      mean: null,
      min: null,
      max: null,
      gaps: 23,
      minutes: 115,
    };
    expect(summaryText(util)).toContain(duration(115 * 60));
    expect(summaryText(util)).not.toContain('null');
  });
  it('connects exact and lower-bound vertices and marks a single lower-bound bucket', () => {
    setLocale(locale);
    const { data, node } = markup([point(8), point(null, { known_allocated_gpus: 9 }), point(10)]);
    expect(segments(data.series[1].buckets)).toEqual([
      { indices: [0], lowerBound: false },
      { indices: [0, 1, 2], lowerBound: true },
    ]);
    expect(node.querySelector('.bucket-bound-mark')?.textContent).toBe('≥');
    expect(
      node.querySelector('[data-lower-bound="true"]')!.getAttribute('d')!.match(/L/g),
    ).toHaveLength(2);
    const isolated = markup([point(null), point(null, { known_allocated_gpus: 9 }), point(null)]);
    expect(isolated.node.querySelector('.bucket-bound-mark')?.textContent).toBe('≥');
    expect(isolated.node.querySelector('.bucket-bound-mark .bucket-bound')).not.toBeNull();
  });
  it.each(['circle', 'rect'] as const)(
    'keeps exact %s markers solid and lower-bound markers as fill-only rings',
    (shape) => {
      setLocale(locale);
      const { data, node } = markup([
        point(null),
        point(8),
        point(null),
        point(null, { known_allocated_gpus: 19.9 }),
      ]);
      // Shared identity slots exercise the square-marker branch too.
      if (shape === 'rect') {
        data.series.forEach((series) => {
          series.slot = 1;
        });
        node.innerHTML = renderToStaticMarkup(<Chart data={data} />);
      }
      const allocation = node.querySelectorAll('.chart-multiple')[1];
      const exact = allocation.querySelector(`[data-lower-bound="false"] + ${shape}`)!;
      expect(exact).not.toBeNull();
      expect(exact.getAttribute('class')).toBe('bucket-dot');
      expect(exact.classList.contains('bucket-bound')).toBe(false);
      const last = data.series[1].buckets.at(-1)!;
      expect(last.lower_bound).toBe(true);
      const center = timeX(
        (Date.parse(last.start) + Date.parse(last.end)) / 2,
        Date.parse(data.start),
        Date.parse(data.end),
      );
      const bounds = node.querySelectorAll('.bucket-bound');
      expect(bounds).toHaveLength(2); // The lower-bound glyph and active-point marker.
      expect(node.querySelectorAll('.bucket-bound-hole')).toHaveLength(2);
      for (const bound of bounds) {
        expect(allocation.contains(bound)).toBe(true);
        const square = bound.tagName === 'rect';
        expect(Number(bound.getAttribute(square ? 'x' : 'cx')) + (square ? 3 : 0)).toBe(center);
        expect(Number(bound.getAttribute(square ? 'y' : 'cy')) + (square ? 3 : 0)).toBe(
          y(19.9, 19.9),
        );
        const hole = bound.nextElementSibling!;
        expect(hole.getAttribute('class')).toBe('bucket-bound-hole');
        expect(hole.tagName).toBe(bound.tagName);
        expect(Number(hole.getAttribute(square ? 'x' : 'cx')) + (square ? 1.5 : 0)).toBe(center);
        expect(Number(hole.getAttribute(square ? 'y' : 'cy')) + (square ? 1.5 : 0)).toBe(
          y(19.9, 19.9),
        );
        if (square) {
          expect(hole.getAttribute('width')).toBe('3');
          expect(hole.getAttribute('height')).toBe('3');
        } else {
          expect(hole.getAttribute('r')).toBe(bound.getAttribute('r') === '4' ? '2.5' : '1.5');
        }
      }
      for (const marker of node.querySelectorAll('.bucket-bound, .bucket-bound-hole')) {
        expect(marker.hasAttribute('stroke')).toBe(false);
        expect(marker.hasAttribute('stroke-dasharray')).toBe(false);
        expect(marker.hasAttribute('stroke-width')).toBe(false);
      }
    },
  );
  it('places the empty explanation before the plot', () => {
    const { node } = markup([point(null)]);
    expect(
      node
        .querySelector('.chart-empty')!
        .compareDocumentPosition(node.querySelector('.chart-plot')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
