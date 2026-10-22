import { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { money, runningPrice, sourceHasData, dateTime, runningHours } from '../domain';
import { findGroup, groupLabel } from '../groups';
import { Chips, Empty, Panel, RankedBars, Stat } from '../ui';
import { useRouteParam } from '../useRouteParam';
import { usageDays, usageTotal } from '../usage';
import type { UsageTotal } from '../usage';
import type { HistoryPoint, UsageRollups } from '../types';
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
  const [range, setRange] = useRouteParam('range', '24h');
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
          <Empty title={t('cloud.empty')} />
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
                  {t('cost.rate', { price: money(rate, currency), currency })}
                </h3>
                <p>
                  {t('usage.projection', {
                    amount: `${spend.unpriced.length ? '≥ ' : '≈ '}${money(rate * 24, currency)}`,
                    currency,
                  })}
                </p>
                <RankedBars
                  format={(value) => t('usage.hourlyRate', { price: money(value, currency) })}
                  items={activeGroups
                    .filter((group) => {
                      const value = summary.groups[group.key]?.spend;
                      return (
                        value?.applies &&
                        (value.rates[currency] != null || value.unpriced.length > 0)
                      );
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
                  {runningHours(
                    item,
                    data.sources.find((source) => source.id === item.source_id),
                  ) && (
                    <InstanceRunCost
                      item={item}
                      source={data.sources.find((source) => source.id === item.source_id)}
                    />
                  )}
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
              setRange(RANGES.find((item) => item.hours === Number(value))!.value)
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

type HistoryResponse = { points: HistoryPoint[]; rollups: UsageRollups };

function UsageRange({ ctx, hours }: { ctx: Ctx; hours: number }) {
  const [result, setResult] = useState<(HistoryResponse & { week: UsageRollups }) | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = ctx.data.history.at(-1)?.at;
  useEffect(() => {
    let active = true;
    const request = (range: number) =>
      api<HistoryResponse>(`/history?hours=${range}&rollup=1&demo=${ctx.demo}`);
    const selected = request(hours);
    Promise.all([selected, hours === 168 ? selected : request(168)])
      .then(([value, week]) => {
        if (active) {
          setResult({ ...value, week: week.rollups });
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [hours, ctx.demo, latest, retry]);
  if (failed)
    return (
      <Empty
        title={t('chart.failed')}
        action={<button onClick={() => setRetry(retry + 1)}>{t('usage.retry')}</button>}
      />
    );
  if (!result)
    return (
      <p className="panel-note" role="status">
        {t('chart.loading')}
      </p>
    );
  return (
    <>
      <UsageHistory rollups={result.rollups} week={result.week} hours={hours} ctx={ctx} />
      <HistoryPanel
        points={result.points}
        hours={hours}
        note={ctx.demo ? t('usage.demo') : t('usage.historyNote', { where: where(ctx) })}
      />
    </>
  );
}

function emptySpend(total: UsageTotal) {
  return t(
    !total.observed ? 'usage.notRecorded' : total.spendKnown ? 'usage.noSpend' : 'status.unknown',
  );
}

function spendText(total: UsageTotal, currency: string) {
  if (!total.observed) return `${t('usage.notRecorded')} · ${currency}`;
  if (!total.spendKnown) return `${t('status.unknown')} · ${currency}`;
  return `${total.spendPartial ? '≥ ' : '≈ '}${money(total.spend[currency] ?? 0, currency)} · ${currency}`;
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
  const number = (value: number) =>
    value.toLocaleString(ctx.locale, { maximumFractionDigits: value >= 100 ? 0 : 1 });
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
              {groupLabel(ctx.groups, key)} ·{' '}
              {total.gpuHours == null
                ? '—'
                : `${total.gpuPartial ? '≥ ' : ''}${number(total.gpuHours)} ${t('usage.gpuHourUnit')}`}
            </summary>
            <RankedBars
              ordered
              limit={Infinity}
              format={number}
              items={days.map((day) => {
                const value = usageTotal(rollups, day.start, day.end, key);
                return {
                  key: String(day.start),
                  label: day.label.toLocaleDateString(ctx.locale),
                  group: findGroup(ctx.groups, key),
                  value: value.gpuHours,
                  partial: value.gpuPartial,
                  note: coverage(value, (day.end - day.start) / 1000),
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
            format={(value) => money(value, currency)}
            items={days.map((day) => {
              const value = usageTotal(rollups, day.start, day.end);
              return {
                key: String(day.start),
                label: day.label.toLocaleDateString(ctx.locale),
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
