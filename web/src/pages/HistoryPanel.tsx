import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HistoryPoint } from '../types';
import { api } from '../api';
import { historyPartial } from '../domain';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { Chips, Panel } from '../ui';
import TrendChart from '../TrendChart';
import { ChartLegend } from './shared';

const RANGES: { hours: number; label: MessageKey }[] = [
  { hours: 24, label: 'chart.range.day' },
  { hours: 72, label: 'chart.range.threeDays' },
  { hours: 168, label: 'chart.range.week' },
];

/** The allocation and utilization chart with a time range. 24 hours come with the dashboard. */
export function HistoryPanel({
  day,
  demo,
  note,
}: {
  day: HistoryPoint[];
  demo: boolean;
  note?: ReactNode;
}) {
  const [hours, setHours] = useState(24);
  const [result, setResult] = useState<{
    hours: number;
    demo: boolean;
    points: HistoryPoint[];
    failed: boolean;
  } | null>(null);
  const longer = result?.hours === hours && result.demo === demo ? result : null;
  useEffect(() => {
    if (hours === 24) return;
    let active = true;
    api<{ points: HistoryPoint[] }>(`/history?hours=${hours}&demo=${demo}`)
      .then((result) => {
        if (active) setResult({ hours, demo, points: result.points, failed: false });
      })
      .catch(() => {
        if (active) {
          setResult({ hours, demo, points: [], failed: true });
        }
      });
    return () => {
      active = false;
    };
  }, [hours, demo]);
  const points = hours === 24 ? day : (longer?.points ?? []);
  const empty =
    hours === 24
      ? undefined
      : longer?.failed
        ? t('chart.failed')
        : longer === null
          ? t('chart.loading')
          : undefined;
  return (
    <Panel
      title={t('chart.heading')}
      actions={
        <>
          <Chips
            label={t('chart.range')}
            value={String(hours)}
            onChange={(value) => {
              if (Number(value) === hours) return;
              setHours(Number(value));
              setResult(null);
            }}
            options={RANGES.map((range) => ({ value: String(range.hours), label: t(range.label) }))}
          />
          <ChartLegend partial={points.some(historyPartial)} />
        </>
      }
    >
      <TrendChart history={points} hours={hours} empty={empty} />
      {note && <p className="panel-note">{note}</p>}
    </Panel>
  );
}
