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
  const [longer, setLonger] = useState<HistoryPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (hours === 24) return;
    let active = true;
    setLonger(null);
    setFailed(false);
    api<{ points: HistoryPoint[] }>(`/history?hours=${hours}&demo=${demo}`)
      .then((result) => {
        if (active) setLonger(result.points);
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setLonger([]);
        }
      });
    return () => {
      active = false;
    };
  }, [hours, demo]);
  const points = hours === 24 ? day : (longer ?? []);
  const empty =
    hours === 24
      ? undefined
      : failed
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
            onChange={(value) => setHours(Number(value))}
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
