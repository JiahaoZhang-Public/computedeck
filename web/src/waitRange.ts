import { lowUseDuration, t } from './i18n';
import type { WaitHistory as History } from './types';

export function waitDuration(seconds: number) {
  if (seconds < 60) return t('wait.seconds', { count: Math.round(seconds) });
  return lowUseDuration(Math.round(seconds / 60));
}

/** The 25th–75th percentile range alone, when a matching bucket has enough samples. */
export function waitRange(
  history: History | undefined,
  qos: string | null,
  partition: string | null | undefined,
  gpus: number | null,
) {
  const partitions = partition?.split(',').map((value) => value.trim());
  const bucket = (history?.status === 'available' ? history.buckets : []).find(
    (item) =>
      item.qos === qos &&
      (partitions ? partitions.includes(item.partition ?? '') : item.partition === null) &&
      gpus != null &&
      gpus >= item.gpu_min &&
      gpus <= item.gpu_max &&
      item.samples >= 8 &&
      item.p25_seconds != null &&
      item.p75_seconds != null,
  );
  return bucket
    ? t('wait.rangeShort', {
        low: waitDuration(bucket.p25_seconds!),
        high: waitDuration(bucket.p75_seconds!),
      })
    : null;
}
