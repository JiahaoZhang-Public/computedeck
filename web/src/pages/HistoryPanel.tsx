import type { ReactNode } from 'react';
import type { HistoryPoint } from '../types';
import { historyPartial } from '../domain';
import { t } from '../i18n';
import { Panel } from '../ui';
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
    <Panel
      title={t('chart.heading')}
      actions={<ChartLegend partial={points.some(historyPartial)} />}
    >
      <TrendChart history={points} hours={hours} empty={empty} />
      {note && <p className="panel-note">{note}</p>}
    </Panel>
  );
}
