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
  controls,
}: {
  data?: ChartData;
  note?: ReactNode;
  controls?: ReactNode;
  empty?: string;
  onRange?: (range: string) => void;
}) {
  return (
    <section className="usage-trend">
      <header className="panel-header">
        <h3>{t('chart.heading')}</h3>
      </header>
      {data ? (
        <Chart key={data.bucket_seconds} data={data} onRange={onRange} controls={controls} />
      ) : (
        <p className="chart-empty">{empty ?? t('chart.unavailable')}</p>
      )}
      {note && <p className="panel-note">{note}</p>}
    </section>
  );
}
