import { Copy } from 'lucide-react';
import { useRouteParam } from '../useRouteParam';
import { instanceGroupKey } from '../groups';
import { lowUseDuration, t } from '../i18n';
import { money, runningPrice, sourceHasData } from '../domain';
import { statusKind, statusLabel } from '../labels';
import { Chips, Empty, Meter, Panel, Stat, Status } from '../ui';
import { StatusShape } from '../ui/Status';
import type { Ctx } from './shared';
import { GroupFilter, SearchBox, StaleMark } from './shared';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { matches } from './util';

export function CloudPage({ ctx }: { ctx: Ctx }) {
  const { data, group, query, remote, groups } = ctx;
  const clouds = groups.filter((item) => item.kind === 'cloud');
  const [use, setUse] = useRouteParam('use', 'all');
  const scoped = data.instances.filter(
    (item) =>
      (group === 'all' || instanceGroupKey(item, data.sources) === group) &&
      matches(query, item.name, item.gpu_type, item.ssh_alias, item.host, item.platform),
  );
  const low = scoped.filter((item) => item.low_use?.state === 'low');
  const unknown = scoped.filter(
    (item) =>
      item.low_use?.state === 'unknown' &&
      item.low_use.reason !== 'not_running' &&
      item.gpu_count !== 0,
  );
  const instances = use === 'low' ? low : use === 'unknown' ? unknown : scoped;
  const spend = (group === 'all' ? data.summary : data.summary.groups[group])?.spend;
  const hasApiSource = data.sources.some((source) => source.kind === 'cloud');
  return (
    <>
      {/* Views of the instance list are page tabs; the platform is a filter chip. */}
      <div className="page-tabs">
        <Chips
          value={use}
          onChange={setUse}
          label={t('lowUse.title')}
          options={[
            { value: 'all', label: t('filter.all'), count: scoped.length },
            {
              value: 'low',
              label: t('lowUse.filter', { minutes: data.low_use_settings?.window_minutes ?? 60 }),
              count: low.length,
            },
            { value: 'unknown', label: t('lowUse.unknownFilter'), count: unknown.length },
          ]}
        />
      </div>
      <div className="toolbar bare">
        <SearchBox ctx={ctx} placeholder={t('cloud.search')} />
        <GroupFilter ctx={ctx} options={clouds} allLabel={t('cloud.allPlatforms')} />
        {!hasApiSource && !ctx.demo && (
          <span className="toolbar-end">
            <button className="link" onClick={() => ctx.configure(undefined, { kind: 'cloud' })}>
              {t('cloud.connectApi')}
            </button>
          </span>
        )}
      </div>
      {spend?.applies && (Object.keys(spend.rates).length > 0 || spend.unpriced.length > 0) && (
        <div className="stats">
          {(Object.keys(spend.rates).length
            ? Object.entries(spend.rates)
            : [['', null] as const]
          ).map(([currency, rate], _, all) => (
            <Stat
              key={currency}
              label={all.length > 1 ? `${t('cost.now')} · ${currency}` : t('cost.now')}
              value={
                <UnmeasuredLinks
                  value={
                    rate == null
                      ? '—'
                      : (spend.unpriced.length ? '≥ ' : '') +
                        t('usage.hourlyRate', {
                          price: money(rate, currency, !!spend.unpriced.length),
                        })
                  }
                  items={spend.unpriced}
                  ctx={ctx}
                  label={t('cost.unpriced', { count: spend.unpriced.length })}
                />
              }
            />
          ))}
        </div>
      )}
      <Panel>
        {instances.length ? (
          <div className="table-wrap">
            <table data-detail-list className="table stack-on-phone meta-on-phone">
              <thead>
                <tr>
                  <th>{t('cloud.col.instance')}</th>
                  <th className="col-high">{t('usage.col.platform')}</th>
                  <th>{t('jobs.col.state')}</th>
                  <th>GPU</th>
                  <th className="phone-hide">{t('cloud.col.utilization')}</th>
                  <th className="phone-hide col-high">
                    {remote ? t('cloud.col.sshRemote', { server: ctx.serverName }) : 'SSH'}
                  </th>
                  <th className="num">{t('cost.price')}</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((item) => {
                  const source = data.sources.find((entry) => entry.id === item.source_id);
                  // Rows of a source that no longer collects keep their last reading.
                  const stale = !!source && !sourceHasData(source, 'instances');
                  const price = runningPrice(item);
                  return (
                    <tr
                      key={item.id}
                      data-detail-key="instance"
                      data-detail-id={item.id}
                      className={`clickable ${stale ? 'stale-row' : ''}`}
                      tabIndex={0}
                      onClick={() => ctx.openInstance(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') ctx.openInstance(item);
                      }}
                    >
                      <td>
                        <strong>{item.name}</strong>
                      </td>
                      <td className="col-high" data-label={t('usage.col.platform')}>
                        {item.platform || '—'}
                      </td>
                      <td data-label={t('jobs.col.state')}>
                        <Status
                          state={item.state === 'reported_running' ? 'running' : item.state}
                        />
                        {stale && <StaleMark at={item.observed_at} />}
                      </td>
                      <td data-label="GPU">
                        {item.gpu_count ?? '?'} × {item.gpu_type || 'GPU'}
                      </td>
                      <td className="phone-hide" data-label={t('cloud.col.utilization')}>
                        <span className="util-cell">
                          {item.low_use?.state === 'low' && (
                            <StatusShape
                              kind="warn"
                              label={t('lowUse.short', {
                                duration: lowUseDuration(item.low_use.covered_minutes),
                              })}
                            />
                          )}
                          {/* No reading is a dash, not an empty bar. */}
                          {item.gpu_utilization == null ? (
                            <span className="muted">—</span>
                          ) : (
                            <Meter value={item.gpu_utilization} />
                          )}
                        </span>
                      </td>
                      <td
                        className="phone-hide col-high"
                        data-label={
                          remote ? t('cloud.col.sshRemote', { server: ctx.serverName }) : 'SSH'
                        }
                      >
                        {item.ssh_alias ? (
                          <span className="copyable">
                            <StatusShape
                              kind={statusKind(item.ssh_status)}
                              label={statusLabel(item.ssh_status)}
                            />
                            <code title={item.ssh_alias}>{item.ssh_alias}</code>
                            <button
                              className="icon-button"
                              aria-label={t('common.copyValue', { value: item.ssh_alias })}
                              onClick={(event) => {
                                event.stopPropagation();
                                void ctx.copy(item.ssh_alias);
                              }}
                            >
                              <Copy size={12} />
                            </button>
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num key" data-label={t('cost.price')}>
                        {price == null && item.hourly_cost != null ? (
                          // Muted: the price applies only while running, as its name says.
                          <span
                            className="muted"
                            title={t('cloud.priceWhenRunning', {
                              price: money(item.hourly_cost, item.currency),
                            })}
                          >
                            <span aria-hidden="true">
                              {t('usage.hourlyRate', {
                                price: money(item.hourly_cost, item.currency),
                              })}
                            </span>
                            <span className="sr-only">
                              {t('cloud.priceWhenRunning', {
                                price: money(item.hourly_cost, item.currency),
                              })}
                            </span>
                          </span>
                        ) : price == null ? (
                          <span className="muted">—</span>
                        ) : (
                          t('usage.hourlyRate', { price: money(price, item.currency) })
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={query || use !== 'all' ? t('cloud.empty.query') : t('cloud.empty')}
            action={
              query || use !== 'all' || ctx.demo ? undefined : (
                <button className="button primary" onClick={ctx.addInstance}>
                  {t('cloud.add')}
                </button>
              )
            }
          />
        )}
      </Panel>
    </>
  );
}
