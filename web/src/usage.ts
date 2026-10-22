import type { UsageRollups } from './types';

export type UsageTotal = {
  gpuHours: number | null;
  spend: Record<string, number>;
  observed: number;
  gpuObserved: number;
  gpuPartial: boolean;
  spendPartial: boolean;
  spendKnown: boolean;
};

/** Clip hourly integrals to the selected range. Boundary hours are prorated. */
export function usageTotal(
  rollups: UsageRollups,
  start: number,
  end: number,
  key?: string,
): UsageTotal {
  const total: UsageTotal = {
    gpuHours: null,
    spend: {},
    observed: 0,
    gpuObserved: 0,
    gpuPartial: false,
    spendPartial: false,
    spendKnown: false,
  };
  for (const bucket of rollups.buckets) {
    const left = Date.parse(bucket.at),
      right = Date.parse(bucket.end);
    const seconds = Math.max(0, Math.min(end, right) - Math.max(start, left)) / 1000;
    if (!seconds) continue;
    const fraction = (seconds * 1000) / (right - left);
    const groups = key
      ? bucket.groups[key]
        ? [bucket.groups[key]]
        : []
      : Object.values(bucket.groups);
    total.observed +=
      (key ? (groups[0]?.observed_seconds ?? 0) : bucket.observed_seconds) * fraction;
    total.spendKnown ||=
      groups.some((group) => Object.keys(group.spend).length > 0) ||
      (groups.length > 0 && groups.every((group) => group.spend_known));
    for (const group of groups) {
      total.gpuObserved += group.gpu_observed_seconds * fraction;
      if (group.gpu_hours != null)
        total.gpuHours = (total.gpuHours ?? 0) + group.gpu_hours * fraction;
      total.gpuPartial ||= group.gpu_partial;
      total.spendPartial ||= group.spend_partial;
      for (const [currency, amount] of Object.entries(group.spend)) {
        total.spend[currency] = (total.spend[currency] ?? 0) + amount * fraction;
      }
    }
  }
  const missing = total.observed < (end - start) / 1000 - 0.001;
  total.gpuPartial ||= missing;
  total.spendPartial ||= missing;
  return total;
}

/** Calendar days in the viewer's timezone, including DST and unrecorded days. */
export function usageDays(start: number, end: number) {
  const days: { start: number; end: number; label: Date }[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < end) {
    const left = cursor.getTime();
    const label = new Date(left);
    cursor.setDate(cursor.getDate() + 1);
    days.push({ start: Math.max(start, left), end: Math.min(end, cursor.getTime()), label });
  }
  return days;
}

/** Collapse only adjacent days with no observations; partial days remain separate. */
export function mergeUnrecordedDays(
  days: ReturnType<typeof usageDays>,
  rollups: UsageRollups,
  key?: string,
) {
  const merged: ReturnType<typeof usageDays> = [];
  let previousMissing = false;
  for (const day of days) {
    const missing = usageTotal(rollups, day.start, day.end, key).observed === 0;
    const previous = merged.at(-1);
    if (missing && previousMissing && previous?.end === day.start) previous.end = day.end;
    else merged.push({ ...day });
    previousMissing = missing;
  }
  return merged;
}
