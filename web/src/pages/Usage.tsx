import { t } from '../i18n';
import { money, runningPrice } from '../domain';
import { Empty, Panel, Stat, Status } from '../ui';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { where } from './util';

export function UsagePage({ ctx }: { ctx: Ctx }) {
  const { data, demo } = ctx;
  const summary = data.summary;
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
      <HistoryPanel
        day={data.history}
        demo={demo}
        note={demo ? t('usage.demo') : t('usage.historyNote', { where: where(ctx) })}
      />
      <Panel title={t('usage.prices')}>
        {data.instances.length ? (
          <div className="table-wrap">
            <table className="table stack-on-phone">
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
                    <td data-label={t('usage.col.platform')}>{item.platform}</td>
                    <td data-label={t('clusters.col.state')}>
                      <Status state={item.state} />
                    </td>
                    <td className="num" data-label={'GPU'}>
                      {item.gpu_count ?? '?'} × {item.gpu_type || 'GPU'}
                    </td>
                    <td className="num" data-label={t('cloud.col.price')}>
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
