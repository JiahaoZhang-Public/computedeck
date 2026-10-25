import type { ReactNode } from 'react';
import type { ChartData } from '../chart/types';
import { Chart } from '../chart/Chart';
import { t } from '../i18n';

/** Presentation only; Usage owns the request and URL range. */
export function HistoryPanel({
  data,
  note,
  empty,
  onRange,
  onPage,
  controls,
  busy = false,
}: {
  data?: ChartData;
  busy?: boolean;
  note?: ReactNode;
  controls?: ReactNode;
  empty?: string;
  onRange?: (range: string) => void;
  onPage?: (direction: -1 | 1) => void;
}) {
  return (
    <section className="usage-trend" aria-busy={busy}>
      <header className="panel-header">
        <h3>{t('chart.heading')}</h3>
      </header>
      {data ? (
        <Chart data={data} onRange={onRange} onPage={onPage} controls={controls} />
      ) : (
        <p className="chart-empty">{empty ?? t('chart.unavailable')}</p>
      )}
      {note && <p className="panel-note">{note}</p>}
    </section>
  );
}
