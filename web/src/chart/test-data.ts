import type { ChartData } from './types';
import type { HistoryPoint } from '../types';

/** A tiny server-shaped fixture; no client production aggregation. */
export function chartFixture(points: HistoryPoint[], end = '2026-10-13T12:00:00Z'): ChartData {
  return {
    start: new Date(Date.parse(end) - 24 * 3600000).toISOString(),
    end,
    as_of: end,
    bucket_seconds: 300,
    last_sample: points.at(-1)?.at ?? null,
    series: ['utilization', 'allocation'].map((id) => ({
      id,
      summary: { code: 'chart_summary', mean: 4, min: 4, max: 4, gaps: 0, minutes: 0, partial: 0 },
      buckets: points.map((point) => {
        const value =
          id === 'utilization'
            ? point.gpu_utilization
            : (point.allocated_gpus ?? point.known_allocated_gpus ?? null);
        const partial = id === 'allocation' && point.allocated_gpus === null && value !== null;
        return {
          start: point.at,
          end: new Date(Date.parse(point.at) + 300000).toISOString(),
          value,
          min: value,
          max: value,
          samples: value === null ? 0 : 1,
          held_from: null,
          expected_samples: 1,
          known_sources: partial ? 1 : 2,
          total_sources: 2,
          partial,
          lower_bound: partial,
          gap_reason: value === null ? { code: 'chart_unknown' } : null,
          so_far: false,
        };
      }),
    })),
  };
}
