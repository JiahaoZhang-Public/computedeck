import { t } from '../i18n';
import { money, runningPrice, summarize } from '../domain';
import { Empty, Panel, Stat, Status } from '../ui';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { where } from './util';

export function UsagePage({ ctx }: { ctx: Ctx }) {
  const { data, demo } = ctx;
  const summary = summarize(data);
  const pct = (value: number | null) => (value == null ? '—' : Math.round(value));
  return (
    <>
      <div className="stats three">
        <Stat
          label={t('usage.gpu')}
          value={pct(summary.utilization)}
          unit={summary.utilization == null ? undefined : '%'}
          hint={t('usage.gpuHint', { count: summary.covered })}
        />
        <Stat
          label={t('usage.cpu')}
          value={pct(summary.cpuUtilization)}
          unit={summary.cpuUtilization == null ? undefined : '%'}
          hint={t('usage.hostHint')}
        />
        <Stat
          label={t('usage.memory')}
          value={pct(summary.memoryUtilization)}
          unit={summary.memoryUtilization == null ? undefined : '%'}
          hint={t('usage.hostHint')}
        />
      </div>
      <HistoryPanel
        day={data.history}
        demo={demo}
        note={demo ? t('usage.demo') : t('usage.historyNote', { where: where(ctx) })}
      />
      <Panel title={t('usage.prices')}>
        {data.instances.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('cloud.col.instance')}</th>
                  <th>{t('usage.col.platform')}</th>
                  <th>{t('clusters.col.state')}</th>
                  <th className="num">GPU</th>
                  <th className="num">{t('cloud.col.price')}</th>
                </tr>
              </thead>
              <tbody>
                {data.instances.map((item) => (
                  <tr key={item.id} className="clickable" onClick={() => ctx.openInstance(item)}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>{item.platform}</td>
                    <td>
                      <Status state={item.state} />
                    </td>
                    <td className="num">
                      {item.gpu_count ?? '?'} × {item.gpu_type || 'GPU'}
                    </td>
                    <td className="num">
                      {runningPrice(item) == null
                        ? '—'
                        : `${money(runningPrice(item), item.currency)}/h`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t('cloud.empty')} />
        )}
        <p className="panel-note">{t('usage.pricesNote')}</p>
      </Panel>
    </>
  );
}
