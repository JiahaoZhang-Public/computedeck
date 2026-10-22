import { Copy, Plus } from 'lucide-react';
import { useRouteParam } from '../useRouteParam';
import { findGroup, instanceGroupKey } from '../groups';
import { lowUseDuration, t } from '../i18n';
import {
  costThisRun,
  money,
  relativeTime,
  runDuration,
  runningHours,
  runningPrice,
  sourceHasData,
} from '../domain';
import { statusLabel } from '../labels';
import { Chips, Empty, GroupMark, Meter, Panel, Status } from '../ui';
import type { Ctx } from './shared';
import { GroupFilter, MachineNodeNote, SearchBox } from './shared';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { matches, where } from './util';

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
      <div className="toolbar bare">
        <GroupFilter ctx={ctx} options={clouds} />
        <div className="toolbar-end">
          {!hasApiSource && !ctx.demo && (
            <button className="link" onClick={() => ctx.configure(undefined, { kind: 'cloud' })}>
              {t('cloud.connectApi')}
            </button>
          )}
          <SearchBox ctx={ctx} placeholder={t('cloud.search')} />
        </div>
      </div>
      <Panel title={t('cloud.instances')} count={instances.length}>
        <div className="low-use-filters">
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
        {spend?.applies && (
          <div className="panel-note">
            <strong>{t('cost.now')}</strong>{' '}
            {Object.entries(spend.rates).length
              ? Object.entries(spend.rates).map(([currency, rate]) => (
                  <span className="sub" key={currency}>
                    {spend.unpriced.length ? '≥ ' : ''}
                    {t('cost.rate', {
                      price: money(rate, currency, !!spend.unpriced.length),
                      currency,
                    })}
                  </span>
                ))
              : spend.unpriced.length
                ? '—'
                : t('cost.none')}
            <span className="sub">{t('cost.scope')}</span>
            {!!spend.unpriced.length && (
              <>
                <span className="sub">{t('cost.unpriced', { count: spend.unpriced.length })}</span>
                <UnmeasuredLinks items={spend.unpriced} ctx={ctx} />
              </>
            )}
          </div>
        )}
        {instances.length ? (
          <div className="table-wrap">
            <table className="table stack-on-phone">
              <thead>
                <tr>
                  <th>{t('cloud.col.instance')}</th>
                  <th>GPU</th>
                  <th>{t('cloud.col.utilization')}</th>
                  <th>{remote ? t('cloud.col.sshRemote', { server: ctx.serverName }) : 'SSH'}</th>
                  <th className="num cloud-price">{t('cloud.col.price')}</th>
                  <th className="num cloud-sampled">{t('cloud.col.sampled')}</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((item) => {
                  const source = data.sources.find((entry) => entry.id === item.source_id);
                  // Rows of a source that no longer collects keep their last reading.
                  const stale = !!source && !sourceHasData(source, 'instances');
                  const price = runningPrice(item);
                  const run = runningHours(item, source);
                  const cost = costThisRun(item, source);
                  return (
                    <tr
                      key={item.id}
                      className={`clickable ${stale ? 'stale-row' : ''}`}
                      tabIndex={0}
                      onClick={() => ctx.openInstance(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') ctx.openInstance(item);
                      }}
                    >
                      <td>
                        <span className="with-mark">
                          <GroupMark
                            group={findGroup(groups, instanceGroupKey(item, data.sources))}
                          />
                          <span>
                            <strong>{item.name}</strong>
                            <span className="sub">
                              {[
                                item.platform,
                                statusLabel(item.state),
                                run
                                  ? t(run.origin === 'provider' ? 'cost.up' : 'cost.seenRunning', {
                                      duration: runDuration(run.hours),
                                    })
                                  : '',
                                cost != null
                                  ? t('cost.shortEstimate', { cost: money(cost, item.currency) })
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                            <MachineNodeNote item={item} />
                            {stale && (
                              <span className="sub">
                                <span className="tag amber">
                                  {t('cloud.staleSince', { time: relativeTime(item.observed_at) })}
                                </span>
                              </span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td data-label={'GPU'}>
                        {item.gpu_count ?? '?'} × {item.gpu_type || 'GPU'}
                        {item.gpu_observed_count != null &&
                          item.gpu_count != null &&
                          item.gpu_observed_count < item.gpu_count && (
                            <span className="sub">
                              {t('cloud.sampledGpus', { count: item.gpu_observed_count })}
                            </span>
                          )}
                      </td>
                      <td data-label={t('cloud.col.utilization')}>
                        {item.low_use?.state === 'low' && (
                          <span className="sub tag amber">
                            {t('lowUse.short', {
                              duration: lowUseDuration(item.low_use.covered_minutes),
                            })}
                          </span>
                        )}
                        {item.low_use?.origin === 'provider' && (
                          <span className="sub">{t('lowUse.provider')}</span>
                        )}
                        <span className="util-pair">
                          <small>GPU</small>
                          <Meter value={item.gpu_utilization} />
                          <small>CPU</small>
                          <Meter value={item.cpu_utilization} />
                        </span>
                      </td>
                      <td
                        data-label={
                          remote ? t('cloud.col.sshRemote', { server: ctx.serverName }) : 'SSH'
                        }
                      >
                        {item.ssh_alias ? (
                          <span className="copyable">
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
                        <span className="sub">
                          <Status state={item.ssh_status} />
                          {item.last_probe_attempt && (
                            <span className="muted">
                              {' · '}
                              {t('instance.checked', {
                                time: relativeTime(item.last_probe_attempt),
                              })}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="num cloud-price" data-label={t('cloud.col.price')}>
                        {price == null ? (
                          <span className="muted">
                            {item.hourly_cost == null
                              ? '—'
                              : t('cloud.priceWhenRunning', {
                                  price: money(item.hourly_cost, item.currency),
                                })}
                          </span>
                        ) : (
                          t('usage.hourlyRate', { price: money(price, item.currency) })
                        )}
                      </td>
                      <td className="num muted cloud-sampled" data-label={t('cloud.col.sampled')}>
                        {relativeTime(item.observed_at)}
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
            text={query || use !== 'all' ? undefined : t('cloud.emptyHint')}
            action={
              query || use !== 'all' || ctx.demo ? undefined : (
                <button className="button primary" onClick={ctx.addInstance}>
                  <Plus size={14} /> {t('cloud.add')}
                </button>
              )
            }
          />
        )}
      </Panel>
      <p className="page-note">
        {remote
          ? t('cloud.note.remote', { server: ctx.serverName })
          : t('cloud.note.local', { where: where(ctx) })}{' '}
        {t('cloud.note.scope')}
      </p>
    </>
  );
}
