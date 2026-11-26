import type { ReactNode } from 'react';
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
  calendarDate,
  clockTime,
  costThisRun,
  runDuration,
  runningHours,
} from '../domain';
import { findGroup } from '../groups';
import { Chips, Empty, Panel, RankedBars, Stat } from '../ui';
import { setRouteParams, useRouteParam } from '../useRouteParam';
import { usageDays, usageTotal, mergeUnrecordedDays } from '../usage';
import type { UsageTotal } from '../usage';
import type { Instance, UsageRollups } from '../types';
import type { ChartData } from '../chart/types';
import { absoluteTime } from '../format';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { UnmeasuredLinks } from './UnmeasuredLinks';

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
      <div className="stats">
        <Stat
          label={t('usage.gpu')}
          value={
            // How many GPUs the average covers is one hover away, not a caption.
            <span
              title={
                summary.utilization == null
                  ? undefined
                  : t('usage.gpuHint', { count: summary.covered })
              }
            >
              {pct(summary.utilization)}
            </span>
          }
          unit={summary.utilization == null ? undefined : '%'}
        />
        <Stat
          label={t('usage.cpu')}
          value={pct(summary.cpu_utilization)}
          unit={summary.cpu_utilization == null ? undefined : '%'}
        />
        <Stat
          label={t('usage.memory')}
          value={pct(summary.memory_utilization)}
          unit={summary.memory_utilization == null ? undefined : '%'}
        />
      </div>
      {spend?.applies && Object.keys(spend.rates).length > 0 && (
        <div className="stats">
          {Object.entries(spend.rates).flatMap(([currency, rate], _, all) => {
            const suffix = all.length > 1 ? ` · ${currency}` : '';
            const partial = !!spend.unpriced.length;
            const unpriced = t('cost.unpriced', { count: spend.unpriced.length });
            return [
              <Stat
                key={`now-${currency}`}
                label={t('cost.now') + suffix}
                value={
                  <UnmeasuredLinks
                    value={
                      (partial ? '≥ ' : '') +
                      t('usage.hourlyRate', { price: money(rate, currency, partial) })
                    }
                    items={spend.unpriced}
                    ctx={ctx}
                    label={unpriced}
                  />
                }
              />,
              <Stat
                key={`day-${currency}`}
                label={t('usage.perDay') + suffix}
                value={
                  <UnmeasuredLinks
                    value={(partial ? '≥ ' : '≈ ') + money(rate * 24, currency, partial)}
                    items={spend.unpriced}
                    ctx={ctx}
                    label={unpriced}
                  />
                }
              />,
            ];
          })}
        </div>
      )}
      <Panel
        title={t('usage.nowGpus')}
        actions={
          // Words are the trigger: an icon alone read as a spinner.
          <UnmeasuredLinks
            items={summary.unmeasured}
            ctx={ctx}
            value={
              summary.unmeasured.length
                ? t('unmeasured.count', { count: summary.unmeasured.length })
                : undefined
            }
          />
        }
      >
        {activeGroups.length ? (
          <RankedBars
            items={activeGroups.map((group) => {
              const value = summary.groups[group.key];
              return {
                key: group.key,
                label: group.label,
                value: value?.allocated ?? value?.known_allocated ?? null,
                partial: value?.allocated == null,
              };
            })}
          />
        ) : (
          <Empty title={t('usage.noGroups')} />
        )}
      </Panel>
      <Panel
        title={t('usage.spendNow')}
        actions={
          spend?.applies && (
            <>
              {/* With a rate shown above, the rate itself opens the unpriced list. */}
              {!Object.keys(spend.rates).length && (
                <UnmeasuredLinks
                  items={spend.unpriced}
                  ctx={ctx}
                  label={t('cost.unpriced', { count: spend.unpriced.length })}
                />
              )}
            </>
          )
        }
      >
        {spend?.applies && (Object.keys(spend.rates).length > 0 || priced.length > 0) ? (
          <>
            {Object.keys(spend.rates).map((currency) => (
              <RankedBars
                key={currency}
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
                      value: value.rates[currency] ?? (value.unpriced.length ? null : 0),
                      partial: !!value.unpriced.length,
                    };
                  })}
              />
            ))}
            {priced.length > 0 && <InstanceCosts ctx={ctx} items={priced} />}
          </>
        ) : (
          <Empty title={spend?.unpriced.length ? t('status.unknown') : t('cost.none')} />
        )}
      </Panel>
      <Panel title={t('usage.overRange')}>
        <UsageRange
          key={String(demo)}
          ctx={ctx}
          hours={hours}
          range={
            // A time range is a small segmented control, beside the tables it governs: the
            // today and seven-day totals above it keep their own periods.
            <div className="segmented">
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
            </div>
          }
        />
      </Panel>
    </>
  );
}

/** Priced instances now: one row each, the drawer has the rest. */
function InstanceCosts({ ctx, items }: { ctx: Ctx; items: Instance[] }) {
  return (
    <div className="table-wrap">
      {/* Money and time need their labels: a narrow card keeps them above each value. */}
      <table data-detail-list className="table stack-on-phone">
        <thead>
          <tr>
            <th>{t('cloud.col.instance')}</th>
            <th className="num">{t('usage.col.rate')}</th>
            <th className="num">{t('usage.col.runningFor')}</th>
            <th className="num">{t('usage.col.costSoFar')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              data-detail-key="instance"
              data-detail-id={item.id}
              className="clickable"
              tabIndex={0}
              onClick={() => ctx.openInstance(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') ctx.openInstance(item);
              }}
            >
              <td>
                <strong>{item.name}</strong>
              </td>
              <td className="num" data-label={t('usage.col.rate')}>
                {t('usage.hourlyRate', { price: money(runningPrice(item), item.currency) })}
              </td>
              <ClockText>
                {() => {
                  const source = ctx.data.sources.find((row) => row.id === item.source_id);
                  const run = runningHours(item, source);
                  const cost = costThisRun(item, source);
                  // Seen running (not reported by the provider): a lower bound.
                  const lower = run?.origin !== 'provider' ? '≥ ' : '';
                  return (
                    <>
                      <td className="num" data-label={t('usage.col.runningFor')}>
                        {run ? lower + runDuration(run.hours) : '—'}
                      </td>
                      <td className="num" data-label={t('usage.col.costSoFar')}>
                        {cost == null ? '—' : (lower || '≈ ') + money(cost, item.currency, !!lower)}
                      </td>
                    </>
                  );
                }}
              </ClockText>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Part of a period was not observed: a mark on the figure, its share in the name. */
type HistoryResponse = { chart?: ChartData; rollups: UsageRollups };

function UsageRange({ ctx, hours, range }: { ctx: Ctx; hours: number; range: ReactNode }) {
  const [result, setResult] = useState<
    (HistoryResponse & { week: UsageRollups; hours: number }) | null
  >(null);
  const [failed, setFailed] = useState<{ at: string; reason: unknown } | null>(null);
  const [end, setEnd] = useRouteParam('end');
  const previousButton = useRef<HTMLButtonElement>(null);
  const [settledRange, setSettledRange] = useState('');
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
  const chartRequest = `/history?hours=${hours}&rollup=1&chart=1&demo=${ctx.demo}${end ? `&end=${encodeURIComponent(end)}` : ''}`;
  useEffect(() => {
    const id = ++requestId.current;
    loading.current = true;
    const selected = api<HistoryResponse>(chartRequest);
    const week =
      hours >= 168
        ? selected
        : api<HistoryResponse>(`/history?hours=168&rollup=1&demo=${ctx.demo}`);
    Promise.all([selected, week])
      .then(([value, week]) => {
        if (id === requestId.current) {
          setResult({ ...value, week: week.rollups, hours });
          setFailed(null);
        }
      })
      .catch((reason: unknown) => {
        if (id === requestId.current) setFailed({ at: new Date().toISOString(), reason });
      })
      .finally(() => {
        if (id === requestId.current) {
          loading.current = false;
          setSettledRange(chartRequest);
        }
      });
    return invalidateRequests;
  }, [hours, ctx.demo, latest, retry, chartRequest, invalidateRequests]);
  function pageWindow(direction: -1 | 1, fromButton = false) {
    if (!result?.chart || (direction === 1 && !end)) return;
    const next = Date.parse(result.chart.end) + hours * HOUR;
    const latest = direction === 1 && next >= Date.parse(result.chart.as_of);
    if (latest && fromButton) previousButton.current?.focus();
    setEnd(direction === -1 ? result.chart.start : latest ? '' : new Date(next).toISOString());
  }
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
      <>
        {/* The range can be changed while a slow one is still loading or has failed. */}
        <div className="usage-range usage-range-alone">{range}</div>
        {failure || (
          <div className="chart-loading">
            <p>{t('chart.loading')}</p>
            <DataState state="loading" rows={2} rowHeight={120} />
          </div>
        )}
      </>
    );
  return (
    <>
      {!ctx.demo && !end && result.chart && (
        <HistoryClock bucketSeconds={result.chart.bucket_seconds} onBucket={refreshChart} />
      )}
      {failure}
      <UsageHistory
        rollups={result.rollups}
        week={result.week}
        hours={result.hours}
        ctx={ctx}
        range={range}
      />
      <HistoryPanel
        busy={settledRange !== chartRequest}
        controls={
          result.chart && (
            <>
              <button
                className="button"
                type="button"
                aria-label={t(hours === 24 ? 'chart.previousHours' : 'chart.previousDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
                ref={previousButton}
                onClick={() => pageWindow(-1)}
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
                onClick={() => pageWindow(1, true)}
              >
                {t(hours === 24 ? 'chart.nextHours' : 'chart.nextDays', {
                  count: hours === 24 ? hours : hours / 24,
                })}
              </button>
              {end && (
                <button
                  className="button"
                  type="button"
                  onClick={() => {
                    previousButton.current?.focus();
                    setEnd('');
                  }}
                >
                  {t('chart.latest')}
                </button>
              )}
            </>
          )
        }
        data={result.chart}
        onPage={pageWindow}
        onRange={(range) => setRouteParams({ range, end: null })}
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
  if (!total.observed || !total.spendKnown) return '—';
  return `${total.spendPartial ? '≥ ' : '≈ '}${money(total.spend[currency] ?? 0, currency, total.spendPartial)}`;
}

/** Daily panels share the same hourly server integrals as the today/seven-day totals. */
export function UsageHistory({
  rollups,
  week = rollups,
  hours,
  ctx,
  range,
}: {
  rollups: UsageRollups;
  week?: UsageRollups;
  hours: number;
  ctx: Ctx;
  /** The control that picks the period of the tables below it. */
  range?: ReactNode;
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
  // Coverage is shown only as an exception: a fully observed period needs no caption.
  const coverage = (total: UsageTotal, seconds: number) =>
    !total.observed
      ? t('usage.notRecorded')
      : total.observed >= seconds - 1
        ? undefined
        : t('usage.coverage', { percent: Math.floor((total.observed / seconds) * 100) });
  const rows = mergeUnrecordedDays(days, rollups);
  const hoursText = (value: UsageTotal) =>
    value.gpuHours == null
      ? '—'
      : `${value.gpuPartial ? '≥ ' : ''}${number(value.gpuHours, value.gpuPartial)}`;
  // A cell's coverage gap is its tooltip; only the period tiles carry a visible mark.
  const cellNote = (value: UsageTotal, seconds: number, gpu = false) =>
    !value.observed
      ? t('usage.notRecorded')
      : gpu && value.gpuHours == null
        ? t('usage.notMeasured')
        : coverage(gpu ? { ...value, observed: value.gpuObserved } : value, seconds);
  return (
    <div className="usage-history">
      <div className="stats">
        {totals.flatMap((total, index) => {
          const label = t(index ? 'usage.sevenDays' : 'usage.today');
          const note = coverage(
            total,
            (weekEnd - (index ? weekEnd - 168 * HOUR : today.getTime())) / 1000,
          );
          return (currencies.length ? currencies : ['']).map((currency) => (
            <Stat
              key={`${index}-${currency}`}
              label={currencies.length > 1 ? `${label} · ${currency}` : label}
              value={
                // A period that was not observed in full: the figure opens how much was.
                <UnmeasuredLinks
                  value={currency ? spendText(total, currency) : emptySpend(total)}
                  items={[]}
                  ctx={ctx}
                  label={note && total.observed > 0 ? note : undefined}
                  note={note && total.observed > 0 ? note : undefined}
                />
              }
            />
          ));
        })}
      </div>
      {range && <div className="usage-range">{range}</div>}
      <h3>{t('usage.gpuHours')}</h3>
      {keys.length ? (
        <div className="table-wrap">
          <table className="table usage-table">
            <thead>
              <tr>
                <th>{t('usage.col.day')}</th>
                {keys.map((key) => (
                  <th key={key} className="num">
                    {findGroup(ctx.groups, key)?.label ??
                      t('usage.removedGroup', { name: key.replace(/^platform:/, '') })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((day) => (
                <tr key={day.start}>
                  <td>{dayLabel(day)}</td>
                  {keys.map((key) => {
                    const value = usageTotal(rollups, day.start, day.end, key);
                    return (
                      <td
                        key={key}
                        className="num"
                        title={cellNote(value, (day.end - day.start) / 1000, true)}
                      >
                        {hoursText(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('usage.col.total')}</th>
                {keys.map((key) => (
                  <td key={key} className="num">
                    {hoursText(usageTotal(rollups, start, end, key))}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p>{t('usage.notRecorded')}</p>
      )}
      <h3>{t('usage.estimatedSpend')}</h3>
      {currencies.length ? (
        <div className="table-wrap">
          <table className="table usage-table">
            <thead>
              <tr>
                <th>{t('usage.col.day')}</th>
                {currencies.map((currency) => (
                  <th key={currency} className="num">
                    {currency}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((day) => {
                const value = usageTotal(rollups, day.start, day.end);
                return (
                  <tr key={day.start}>
                    <td>{dayLabel(day)}</td>
                    {currencies.map((currency) => (
                      <td
                        key={currency}
                        className="num"
                        title={cellNote(value, (day.end - day.start) / 1000)}
                      >
                        {spendText(value, currency)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('usage.col.total')}</th>
                {currencies.map((currency) => (
                  <td key={currency} className="num">
                    {spendText(usageTotal(rollups, start, end), currency)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p>{emptySpend(usageTotal(rollups, start, end))}</p>
      )}
    </div>
  );
}
