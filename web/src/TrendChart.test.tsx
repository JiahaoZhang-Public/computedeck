import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TrendChart from './TrendChart';
import type { HistoryPoint } from './types';

const now = new Date('2026-10-12T12:00:00Z');
const point = (hoursAgo: number, utilization: number | null = 50): HistoryPoint => ({
  at: new Date(now.getTime() - hoursAgo * 3600000).toISOString(),
  allocated_gpus: 4,
  gpu_utilization: utilization,
  coverage_count: 4,
});
afterEach(() => vi.useRealTimers());
describe('trend chart sampling gaps', () => {
  it('leaves the recent eight-hour outage visible at the right edge', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const html = renderToStaticMarkup(<TrendChart history={[point(9), point(8)]} />);
    const positions = [...html.matchAll(/class="chart-bar" x="([\d.]+)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(positions).toHaveLength(2);
    expect(Math.max(...positions)).toBeLessThan(510);
  });
  it('renders isolated hourly utilization samples visibly without bridging outages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const html = renderToStaticMarkup(<TrendChart history={[point(3), point(2), point(1)]} />);
    expect(html.match(/class="chart-dot"/g)).toHaveLength(3);
    expect(html.match(/class="chart-line"/g)).toHaveLength(3);
    expect(html).not.toMatch(/d="M[^"]* L/);
  });
  it('does not fill a missing sample with a utilization line', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const html = renderToStaticMarkup(
      <TrendChart history={[point(0.3), point(0.2, null), point(0.1)]} />,
    );
    expect(html.match(/class="chart-dot"/g)).toHaveLength(2);
    expect(html.match(/class="chart-line"/g)).toHaveLength(2);
  });
  it('ignores expired and future observations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const html = renderToStaticMarkup(<TrendChart history={[point(25), point(-1)]} />);
    expect(html).toContain('chart-empty');
    expect(html).not.toContain('chart-dot');
  });
});

describe('partial allocation samples', () => {
  const sample = (hoursAgo: number, extra: Partial<HistoryPoint>): HistoryPoint => ({
    ...point(hoursAgo, null),
    ...extra,
  });
  it('hatches a lower-bound bar and says so in its title', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const html = renderToStaticMarkup(
      <TrendChart
        history={[
          sample(0.5, {
            allocated_gpus: 8,
            known_allocated_gpus: 8,
            unknown_allocation_sources: 0,
          }),
          // One source was not collected: only a lower bound of 8 is known.
          sample(0.2, {
            allocated_gpus: null,
            known_allocated_gpus: 8,
            unknown_allocation_sources: 1,
          }),
        ]}
      />,
    );
    const bars = [...html.matchAll(/<rect class="([^"]*)"[^>]*height="([\d.]+)"[^>]*?(\/>|>)/g)];
    expect(bars.map((bar) => bar[1])).toEqual(['chart-bar', 'chart-bar partial']);
    // The same height, told apart by the hatch.
    expect(bars[0][2]).toBe(bars[1][2]);
    expect(html).toMatch(/class="chart-bar partial"[^>]*style="fill:url\(#chart-hatch-[\w-]+\)"/);
    expect(html).toContain('<title>At least 8 GPUs in use; some sources were not counted</title>');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });
});
