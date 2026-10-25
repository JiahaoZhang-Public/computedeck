import { useCallback, useEffect, useRef, useState } from 'react';
import { useClock } from '../ui/clock';
import { ClockText } from '../data/ClockText';
import { api } from '../api';
import { errorText, t } from '../i18n';
import { DataState } from '../ui/DataState';
import {
  money,
  runningPrice,
  sourceHasData,
  dateTime,
  calendarDate,
  clockTime,
  runningHours,
} from '../domain';
import { findGroup } from '../groups';
import { Chips, Empty, Panel, RankedBars, Stat } from '../ui';
import { setRouteParams, useRouteParam } from '../useRouteParam';
import { usageDays, usageTotal, mergeUnrecordedDays } from '../usage';
import type { UsageTotal } from '../usage';
import type { UsageRollups } from '../types';
import type { ChartData } from '../chart/types';
import { absoluteTime } from '../format';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { InstanceRunCost } from './shared';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { where } from './util';

const HOUR = 3600000;
const RANGES = [
  { value: '24h', hours: 24 },
  { value: '7d', hours: 168 },
  { value: '30d', hours: 720 },
];

export function UsagePage({ ctx }: { ctx: Ctx }) {
  const { data, demo, groups } = ctx;
  const summary = data.summary;
  const spend = summary.spend;
  const [range] = useRouteParam('range', '24h');
  // Keep old bookmarked ranges readable; new controls always write units.
  const hours =
    RANGES.find((item) => item.value === range)?.hours ??
    { '24': 24, '72': 168, '168': 168, '3d': 168 }[range] ??
    24;
  const pct = (value: number | null) => (value == null ? '—' : Math.round(value));
  const activeGroups = groups.filter(
    (group) => group.sources.some((source) => source.enabled) || !group.sources.length,
  );
  const priced = data.instances.filter((item) => {
    const source = data.sources.find((source) => source.id === item.source_id);
    return (
      runningPrice(item) != null &&
      (item.manual || (!!source && source.driver !== 'ssh' && sourceHasData(source, 'instances')))
    );
  });
  return (
    <>
      <h2 className="usage-heading">{t('usage.now')}</h2>
      <p className="panel-note">{t('usage.scope')}</p>
      <div className="stats three">
        <Stat
          label={t('usage.gpu')}
          value={pct(summary.utilization)}
          unit={summary.utilization == null ? undefined : '%'}
          hint={t('usage.gpuHint', { count: summary.covered })}
        />
        <Stat
          label={t('usage.cpu')}
          value={pct(summary.cpu_utilization)}
          unit={summary.cpu_utilization == null ? undefined : '%'}
          hint={t('usage.hostHint')}
        />
        <Stat
          label={t('usage.memory')}
          value={pct(summary.memory_utilization)}
          unit={summary.memory_utilization == null ? undefined : '%'}
          hint={t('usage.hostHint')}
        />
      </div>
      <Panel title={t('usage.nowGpus')}>
        {activeGroups.length ? (
          <RankedBars
            items={activeGroups.map((group) => {
              const value = summary.groups[group.key];
              return {
                key: group.key,
                label: group.label,
                group,
                value: value?.allocated ?? value?.known_allocated ?? null,
                partial: value?.allocated == null,
              };
            })}
          />
        ) : (
          <Empty title={t('usage.noGroups')} />
        )}
        {!!summary.unmeasured.length && (
          <div className="panel-note">
            <UnmeasuredLinks items={summary.unmeasured} ctx={ctx} />
          </div>
        )}
      </Panel>
      <Panel title={t('usage.spendNow')}>
        {spend?.applies ? (
          <>
            {Object.entries(spend.rates).map(([currency, rate]) => (
              <div key={currency} className="usage-block">
                <h3>
                  {spend.unpriced.length ? '≥ ' : ''}
                  {t('cost.rate', {
                    price: money(rate, currency, !!spend.unpriced.length),
                    currency,
                  })}
                </h3>
                <p>
                  {t('usage.projection', {
                    amount: `${spend.unpriced.length ? '≥ ' : '≈ '}${money(rate * 24, currency, !!spend.unpriced.length)}`,
                    currency,
                  })}
                </p>
                <RankedBars
                  format={(value, partial) =>
                    t('usage.hourlyRate', { price: money(value, currency, partial) })
                  }
                  items={activeGroups
                    .filter((group) => {
                      const value = summary.groups[group.key]?.spend;
                      return value?.applies && value.rates[currency] != null;
                    })
                    .map((group) => {
                      const value = summary.groups[group.key].spend!;
                      return {
                        key: group.key,
                        label: group.label,
                        group,
                        value: value.rates[currency] ?? (value.unpriced.length ? null : 0),
                        partial: !!value.unpriced.length,
                      };
                    })}
                />
              </div>
            ))}
            {!Object.keys(spend.rates).length && (
              <p className="panel-note">
                {spend.unpriced.length ? t('status.unknown') : t('cost.none')}
              </p>
            )}
            {!!spend.unpriced.length && (
              <div className="panel-note">
                <p>{t('cost.unpriced', { count: spend.unpriced.length })}</p>
                <UnmeasuredLinks items={spend.unpriced} ctx={ctx} />
              </div>
            )}
            <ul className="usage-instances">
              {priced.map((item) => (
                <li key={item.id}>
                  <button className="link" onClick={() => ctx.openInstance(item)}>
                    {item.name} ·{' '}
                    {t('cost.rate', {
                      price: money(runningPrice(item), item.currency),
                      currency: item.currency,
                    })}
                  </button>
                  <ClockText>
                    {() => {
                      const source = data.sources.find((row) => row.id === item.source_id);
                      return (
                        runningHours(item, source) && (
                          <InstanceRunCost item={item} source={source} />
                        )
                      );
                    }}
                  </ClockText>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty title={t('cost.none')} />
        )}
        <p className="panel-note">{t('usage.pricesNote')}</p>
      </Panel>
      <Panel
        title={t('usage.overRange')}
        actions={
          <Chips
            label={t('chart.range')}
            value={String(hours)}
            onChange={(value) =>
              setRouteParams({
                range: RANGES.find((item) => item.hours === Number(value))!.value,
                end: null,
              })
            }
            options={RANGES.map((item) => ({
              value: String(item.hours),
              label: t(
                item.hours === 24
                  ? 'chart.range.day'
                  : item.hours === 168
                    ? 'chart.range.week'
                    : 'usage.month',
              ),
            }))}
          />
        }
      >
        <UsageRange key={`${demo}:${hours}`} ctx={ctx} hours={hours} />
      </Panel>
    </>
  );
}

type HistoryResponse = { chart?: ChartData; rollups: UsageRollups };

function UsageRange({ ctx, hours }: { ctx: Ctx; hours: number }) {
  const [result, setResult] = useState<(HistoryResponse & { week: UsageRollups }) | null>(null);
  const [failed, setFailed] = useState<{ at: string; reason: unknown } | null>(null);
  const [end, setEnd] = useRouteParam('end');
  const [retry, setRetry] = useState(0);
  const requestId = useRef(0);
  const loading = useRef(false);
  const invalidateRequests = useCallback(() => {
    requestId.current++;
  }, []);
  const refreshChart = useCallback(async () => {
    if (loading.current) return;
    const id = ++requestId.current;
    loading.current = true;
    try {
      const value = await api<Pick<HistoryResponse, 'chart'>>(
        `/history?hours=${hours}&chart=1&demo=${ctx.demo}`,
      );
      if (id === requestId.current) {
        setResult((previous) => (previous ? { ...previous, chart: value.chart } : previous));
        setFailed(null);
      }
    } catch (reason) {
      if (id === requestId.current) setFailed({ at: new Date().toISOString(), reason });
    } finally {
      if (id === requestId.current) loading.current = false;
    }
  }, [hours, ctx.demo]);
  const latest = ctx.data.history.at(-1)?.at;
  useEffect(() => {
    const id = ++requestId.current;
    loading.current = true;
    const request = (range: number) =>
      api<HistoryResponse>(
        `/history?hours=${range}&rollup=1&chart=1&demo=${ctx.demo}${end ? `&end=${encodeURIComponent(end)}` : ''}`,
      );
    const selected = request(hours);
    Promise.all([selected, hours >= 168 ? selected : request(168)])
      .then(([value, week]) => {
        if (id === requestId.current) {
          setResult({ ...value, week: week.rollups });
          setFailed(null);
        }
      })
      .catch((reason: unknown) => {
        if (id === requestId.current) setFailed({ at: new Date().toISOString(), reason });
      })
      .finally(() => {
        if (id === requestId.current) loading.current = false;
      });
    return invalidateRequests;
  }, [hours, ctx.demo, latest, retry, end, invalidateRequests]);
  const failure = failed && (
    <Empty
      title={`${t('chart.failed')} · ${errorText(failed.reason, 'chart.failed')} · ${absoluteTime(failed.at)}`}
      action={
        <button className="button small" onClick={() => setRetry(retry + 1)}>
          {t('usage.retry')}
        </button>
      }
    />
  );
  if (!result)
    return (
      failure || (
        <div className="chart-loading">
          <p>{t('chart.loading')}</p>
          <DataState state="loading" rows={2} rowHeight={120} />
        </div>
      )
    );
  return (
    <>
      {!ctx.demo && !end && result.chart && (
        <HistoryClock bucketSeconds={result.chart.bucket_seconds} onBucket={refreshChart} />
      )}
      {failure}
      <UsageHistory rollups={result.rollups} week={result.week} hours={hours} ctx={ctx} />
      <HistoryPanel
        controls={
          result.chart && (
            <>
              <button
                className="button"
                type="button"
                aria-label={t(hours === 24 ? 'chart.previousHours' : 'chart.previousDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
                onClick={() => setEnd(result.chart!.start)}
              >
                {t(hours === 24 ? 'chart.previousHours' : 'chart.previousDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
              </button>
              <button
                className="button"
                type="button"
                aria-label={t(hours === 24 ? 'chart.nextHours' : 'chart.nextDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
                disabled={!end}
                onClick={() => {
                  const next = Date.parse(result.chart!.end) + hours * HOUR;
                  setEnd(
                    next >= Date.parse(result.chart!.as_of) ? '' : new Date(next).toISOString(),
                  );
                }}
              >
                {t(hours === 24 ? 'chart.nextHours' : 'chart.nextDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
              </button>
              {end && (
                <button className="button" type="button" onClick={() => setEnd('')}>
                  {t('chart.latest')}
                </button>
              )}
            </>
          )
        }
        data={result.chart}
        onRange={(range) => setRouteParams({ range, end: null })}
        note={ctx.demo ? t('usage.demo') : t('usage.historyNote', { where: where(ctx) })}
      />
    </>
  );
}

/** Advance a live server window even during a collection outage. No chart-local timer. */
function HistoryClock({
  bucketSeconds,
  onBucket,
}: {
  bucketSeconds: number;
  onBucket: () => void;
}) {
  const minute = useClock();
  const previous = useRef<number | null>(null);
  const bucket = Math.floor(minute / (bucketSeconds * 1000));
  useEffect(() => {
    if (previous.current === null) {
      previous.current = Math.floor(Date.now() / (bucketSeconds * 1000));
      return;
    }
    if (bucket === previous.current) return;
    previous.current = bucket;
    if (!document.hidden) onBucket();
  }, [bucket, bucketSeconds, onBucket]);
  return null;
}

function emptySpend(total: UsageTotal) {
  return t(
    !total.observed ? 'usage.notRecorded' : total.spendKnown ? 'usage.noSpend' : 'status.unknown',
  );
}

function spendText(total: UsageTotal, currency: string) {
  if (!total.observed) return `${t('usage.notRecorded')} · ${currency}`;
  if (!total.spendKnown) return `${t('status.unknown')} · ${currency}`;
  return `${total.spendPartial ? '≥ ' : '≈ '}${money(total.spend[currency] ?? 0, currency, total.spendPartial)} · ${currency}`;
}

/** Daily panels share the same hourly server integrals as the today/seven-day totals. */
export function UsageHistory({
  rollups,
  week = rollups,
  hours,
  ctx,
}: {
  rollups: UsageRollups;
  week?: UsageRollups;
  hours: number;
  ctx: Ctx;
}) {
  const end = Date.parse(rollups.end),
    start = end - hours * HOUR;
  const days = usageDays(start, end);
  const weekEnd = Date.parse(week.end);
  const today = new Date(weekEnd);
  today.setHours(0, 0, 0, 0);
  const totals = [
    usageTotal(week, today.getTime(), weekEnd),
    usageTotal(week, weekEnd - 168 * HOUR, weekEnd),
  ];
  const keys = [
    ...new Set(
      rollups.buckets
        .filter((bucket) => Date.parse(bucket.end) > start)
        .flatMap((bucket) => Object.keys(bucket.groups)),
    ),
  ];
  const currencies = [
    ...new Set(
      [...rollups.buckets, ...week.buckets].flatMap((bucket) =>
        Object.values(bucket.groups).flatMap((group) => Object.keys(group.spend)),
      ),
    ),
  ].sort();
  const number = (value: number, partial: boolean) =>
    (partial ? value + 1e-9 * Math.max(1, Math.abs(value)) : value).toLocaleString(ctx.locale, {
      maximumFractionDigits: value >= 100 ? 0 : 1,
      roundingMode: partial ? 'floor' : 'halfExpand',
    });
  const dayLabel = (day: (typeof days)[number]) => {
    const nextDay = new Date(day.label);
    nextDay.setDate(nextDay.getDate() + 1);
    if (day.end > nextDay.getTime())
      return `${calendarDate(day.label)} – ${calendarDate(new Date(day.end - 1))}`;
    return [
      calendarDate(day.label),
      day.start > day.label.getTime() ? t('usage.dayFrom', { time: clockTime(day.start) }) : '',
      day.end < nextDay.getTime() ? t('usage.dayUntil', { time: clockTime(day.end) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const coverage = (total: UsageTotal, seconds: number) =>
    !total.observed
      ? t('usage.notRecorded')
      : t('usage.coverage', {
          percent:
            total.observed >= seconds - 1 ? 100 : Math.floor((total.observed / seconds) * 100),
        });
  return (
    <div className="usage-history">
      <p>{t('usage.historyEstimate')}</p>
      <p className="sub">{t('cost.asOf', { time: dateTime(rollups.end) })}</p>
      <div className="stats three">
        {totals.map((total, index) => (
          <Stat
            key={index}
            label={t(index ? 'usage.sevenDays' : 'usage.today')}
            value={
              currencies.length
                ? currencies.map((currency) => (
                    <span className="sub" key={currency}>
                      {spendText(total, currency)}
                    </span>
                  ))
                : emptySpend(total)
            }
            hint={coverage(
              total,
              (weekEnd - (index ? weekEnd - 168 * HOUR : today.getTime())) / 1000,
            )}
          />
        ))}
      </div>
      <h3>{t('usage.gpuHours')}</h3>
      {!keys.length && <p>{t('usage.notRecorded')}</p>}
      {keys.map((key) => {
        const total = usageTotal(rollups, start, end, key);
        return (
          <details className="usage-daily" key={key}>
            <summary>
              {findGroup(ctx.groups, key)?.label ??
                t('usage.removedGroup', { name: key.replace(/^platform:/, '') })}{' '}
              ·{' '}
              {total.gpuHours == null
                ? '—'
                : `${total.gpuPartial ? '≥ ' : ''}${number(total.gpuHours, total.gpuPartial)} ${t('usage.gpuHourUnit')}`}
            </summary>
            <RankedBars
              ordered
              limit={Infinity}
              format={number}
              items={mergeUnrecordedDays(days, rollups, key).map((day) => {
                const value = usageTotal(rollups, day.start, day.end, key);
                return {
                  key: String(day.start),
                  label: dayLabel(day),
                  group: findGroup(ctx.groups, key),
                  value: value.gpuHours,
                  partial: value.gpuPartial,
                  note: !value.observed
                    ? t('usage.notRecorded')
                    : value.gpuHours == null
                      ? t('usage.notMeasured')
                      : coverage(
                          { ...value, observed: value.gpuObserved },
                          (day.end - day.start) / 1000,
                        ),
                };
              })}
            />
          </details>
        );
      })}
      <h3>{t('usage.estimatedSpend')}</h3>
      {!currencies.length && <p>{emptySpend(usageTotal(rollups, start, end))}</p>}
      {currencies.map((currency) => (
        <div key={currency}>
          <h4>{spendText(usageTotal(rollups, start, end), currency)}</h4>
          <RankedBars
            ordered
            limit={Infinity}
            format={(value, partial) => money(value, currency, partial)}
            items={mergeUnrecordedDays(days, rollups).map((day) => {
              const value = usageTotal(rollups, day.start, day.end);
              return {
                key: String(day.start),
                label: dayLabel(day),
                value: value.observed && value.spendKnown ? (value.spend[currency] ?? 0) : null,
                partial: value.spendPartial,
                note: coverage(value, (day.end - day.start) / 1000),
              };
            })}
          />
        </div>
      ))}
    </div>
  );
}
