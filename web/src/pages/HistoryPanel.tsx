import type { ReactNode } from 'react';
import type { HistoryPoint } from '../types';
import { historyPartial } from '../domain';
import { t } from '../i18n';
import TrendChart from '../TrendChart';
import { ChartLegend } from './shared';

/** Chart presentation; Usage owns the range and its observations. */
export function HistoryPanel({
  points,
  hours,
  note,
  empty,
}: {
  points: HistoryPoint[];
  hours: number;
  note?: ReactNode;
  empty?: string;
}) {
  return (
    <section className="usage-trend">
      <header className="panel-header">
        <h3>{t('chart.heading')}</h3>
        <ChartLegend partial={points.some(historyPartial)} />
      </header>
      <TrendChart history={points} hours={hours} empty={empty} />
      {note && <p className="panel-note">{note}</p>}
    </section>
  );
}
