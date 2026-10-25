import type { Bucket, ChartSeries } from './types';

export const W = 760;
export const H = 120;
export const LEFT = 36;
export const timeX = (at: number, start: number, end: number, width = W) =>
  LEFT + ((at - start) / (end - start)) * (width - LEFT - 8);
export const y = (value: number, max: number) => H - 8 - (value / max) * (H - 16);

/** Break at every unknown bucket and every change between exact and lower-bound data. */
export function segments(buckets: Bucket[]) {
  const result: number[][] = [];
  buckets.forEach((bucket, i) => {
    if (bucket.value === null) return;
    const previous = result.at(-1);
    if (
      previous?.at(-1) === i - 1 &&
      buckets[i - 1].end === bucket.start &&
      buckets[i - 1].lower_bound === bucket.lower_bound
    )
      previous.push(i);
    else result.push([i]);
  });
  return result;
}

/** Merge neighboring missing bins; hatch edges describe the whole outage. */
export function gapBands(buckets: Bucket[]) {
  const bands: { start: string; end: string; reason: Bucket['gap_reason'] }[] = [];
  for (const bucket of buckets) {
    if (bucket.value !== null) continue;
    const previous = bands.at(-1);
    if (previous?.end === bucket.start && previous.reason?.code === bucket.gap_reason?.code)
      previous.end = bucket.end;
    else bands.push({ start: bucket.start, end: bucket.end, reason: bucket.gap_reason });
  }
  return bands;
}

/** Identity belongs to groups; a later sharer keeps its direct label and a square marker. */
export function seriesStyles(series: ChartSeries[]) {
  const used = new Set<number>();
  return series.map((item) => {
    const collision = item.slot !== undefined && used.has(item.slot);
    if (item.slot !== undefined) used.add(item.slot);
    return {
      color: item.slot !== undefined && !collision ? `var(--id-${item.slot})` : 'var(--chart-line)',
      square: collision,
    };
  });
}
