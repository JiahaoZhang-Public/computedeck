import { dateTime, relativeTime } from './domain';
import { lowUseDuration, t } from './i18n';
import type { WaitHistory as History } from './types';

function waitDuration(seconds: number) {
  if (seconds < 60) return t('wait.seconds', { count: Math.round(seconds) });
  return lowUseDuration(Math.round(seconds / 60));
}

/** Both views consume the same server percentiles; history never changes ranking. */
export function WaitHistory({
  history,
  qos,
  partition,
  gpus,
  compact = false,
}: {
  history: History | undefined;
  qos: string | null;
  /** The planner has no partition selection; show each observed partition separately. */
  partition?: string | null;
  gpus: number | null;
  compact?: boolean;
}) {
  const partitions = partition?.split(',').map((value) => value.trim());
  const buckets = (history?.buckets ?? []).filter(
    (bucket) =>
      bucket.qos === qos &&
      (partition === undefined ||
        (partitions ? partitions.includes(bucket.partition ?? '') : bucket.partition === null)) &&
      gpus != null &&
      gpus >= bucket.gpu_min &&
      gpus <= bucket.gpu_max,
  );
  const missing =
    !history || history.status === 'not_collected'
      ? 'wait.notCollected'
      : history.status === 'unavailable'
        ? 'wait.unavailable'
        : history.status === 'unsupported'
          ? 'wait.unsupported'
          : gpus == null
            ? 'wait.unknownGpus'
            : null;
  // A multi-partition request must not hide partitions that have no matching samples.
  const rows = partitions
    ? partitions.map((name) => ({ name, bucket: buckets.find((b) => b.partition === name) }))
    : buckets.length
      ? buckets.map((bucket) => ({ name: bucket.partition, bucket }))
      : [{ name: partition, bucket: undefined }];
  function value(bucket: History['buckets'][number] | undefined) {
    return bucket && bucket.samples >= 8 && bucket.p25_seconds != null && bucket.p75_seconds != null
      ? t('wait.range', {
          low: waitDuration(bucket.p25_seconds),
          high: waitDuration(bucket.p75_seconds),
          count: bucket.samples,
        })
      : t('wait.insufficient', { count: bucket?.samples ?? 0 });
  }
  if (compact) {
    return (
      <div className="wait-history wait-history-compact">
        {missing ? (
          <p>{t('wait.line', { value: t(missing) })}</p>
        ) : (
          rows.map(({ name, bucket }, index) => (
            <p key={name ?? index}>
              {t('wait.line', { value: value(bucket) })}
              {rows.length > 1 &&
                ` · ${t('wait.partition', { partition: name || t('status.unknown') })}`}
            </p>
          ))
        )}
      </div>
    );
  }
  return (
    <section className="wait-history">
      <strong>{t('wait.title')}</strong>
      {missing ? (
        <p>{t(missing)}</p>
      ) : (
        rows.map(({ name, bucket }, index) => (
          <p key={name ?? index}>
            <span className="sub">
              {t('wait.scope', {
                qos: qos || t('status.unknown'),
                partition: name || t('status.unknown'),
              })}
              {bucket &&
                ` · ${t('wait.bucket', {
                  gpus:
                    bucket.gpu_min === bucket.gpu_max
                      ? bucket.gpu_min
                      : `${bucket.gpu_min}–${bucket.gpu_max}`,
                })}`}
            </span>
            {value(bucket)}
          </p>
        ))
      )}
      <WaitHistoryNote histories={[history]} />
    </section>
  );
}

/** One age per panel; missing ages are not silently replaced with a newer source. */
export function WaitHistoryNote({
  histories,
  relative = false,
}: {
  histories: (History | undefined)[];
  relative?: boolean;
}) {
  const available = histories.filter((h) => h?.status === 'available');
  const dates = available.map((h) => h!.observed_at);
  const oldest =
    dates.length && dates.every((at) => at && Number.isFinite(Date.parse(at)))
      ? dates.reduce((oldest, at) => (Date.parse(at!) < Date.parse(oldest!) ? at : oldest))
      : null;
  return (
    <div className="wait-history-note">
      <p className="sub">{t('wait.note')}</p>
      {available.length > 0 &&
        (oldest ? (
          <time className="sub" dateTime={oldest} title={dateTime(oldest)}>
            {t('wait.asOf', { time: relative ? relativeTime(oldest) : dateTime(oldest) })}
          </time>
        ) : (
          <span className="sub">{t('wait.asOfUnknown')}</span>
        ))}
    </div>
  );
}
