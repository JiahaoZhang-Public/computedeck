import { ClockText } from '../data/ClockText';
import { useEffect } from 'react';
import type { Source } from '../types';
import type { Group } from '../groups';
import { instanceGroupKey } from '../groups';
import { localized, t } from '../i18n';
import { driverInfo, fieldValue, primaryField } from '../drivers';
import { relativeTime } from '../domain';
import { sourceState } from '../labels';
import { routeHash } from '../routes';
import { Empty, Panel, Status } from '../ui';
import type { Ctx } from './shared';
import { RoutesPanel } from './RoutesPanel';

/**
 * One row a source: what it is, how it is reached and its state. What it reads, its errors and
 * its actions are in the pane the row opens.
 */
function SourceRow({
  source,
  group,
  routeColumn,
  ctx,
}: {
  source: Source;
  group: Group;
  routeColumn: boolean;
  ctx: Ctx;
}) {
  const info = driverInfo(ctx.drivers, source.driver, group.kind);
  const primary = primaryField(info);
  const reference = primary ? fieldValue(source, primary.key) : '';
  // A cluster login is its username at an SSH host; an API account is its key reference.
  const connection = [
    reference,
    primary?.key !== 'ssh_alias' && info.fields.some((field) => field.key === 'ssh_alias')
      ? source.ssh_alias
      : '',
  ]
    .filter(Boolean)
    .join('@');
  const name = group.kind === 'cluster' ? group.label : source.name;
  const route = ctx.nodes.find((item) => item.id === source.node);
  return (
    <tr
      className="clickable"
      tabIndex={0}
      aria-label={t('attention.diagnosis', { name: reference ? `${name} · ${reference}` : name })}
      onClick={() => ctx.diagnose(source)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) ctx.diagnose(source);
      }}
    >
      <td>
        <strong>{name}</strong>
      </td>
      <td className="col-mid panel-hide phone-hide" data-label={t('sources.col.type')}>
        {localized(info.label)}
      </td>
      <td className="mono" data-label={t('sources.col.connection')}>
        {connection || '—'}
      </td>
      {routeColumn && (
        <td
          className={`col-low panel-hide ${source.node ? '' : 'no-value'}`}
          data-label={t('sources.col.route')}
        >
          {source.node ? (route?.name ?? source.node) : '—'}
        </td>
      )}
      <td className="num" data-label={t('clusters.col.lastSuccess')}>
        <ClockText>{() => relativeTime(source.last_success)}</ClockText>
      </td>
      <td data-label={t('clusters.col.state')}>
        <Status state={sourceState(source)} />
      </td>
    </tr>
  );
}

/** The one place where sources are added, checked and changed. */
export function SourcesPage({ ctx }: { ctx: Ctx }) {
  const { groups, data } = ctx;
  const collected = groups.filter((group) => group.sources.length);
  const manual = groups.filter((group) => !group.sources.length);
  const selected =
    ctx.group === 'all' ? undefined : groups.find((group) => group.key === ctx.group);
  const targetId = selected
    ? selected.sources.length
      ? `source-group:${selected.key}`
      : 'source-manual'
    : null;
  useEffect(() => {
    if (targetId) document.getElementById(targetId)?.scrollIntoView({ block: 'start' });
  }, [ctx.group, targetId]);
  if (!collected.length && !manual.length)
    return (
      <>
        <Panel>
          <Empty
            title={t('settings.noSources')}
            action={
              ctx.demo ? undefined : (
                <button className="button" onClick={() => ctx.configure()}>
                  {t('source.add')}
                </button>
              )
            }
          />
        </Panel>
        <RoutesPanel ctx={ctx} onChange={ctx.reload} />
      </>
    );
  const routeColumn = collected.some((group) => group.sources.some((source) => source.node));
  return (
    <>
      {collected.length > 0 && (
        <Panel>
          <div className="table-wrap">
            <table className="table stack-on-phone meta-on-phone">
              <thead>
                <tr>
                  <th>{t('sources.col.name')}</th>
                  <th className="col-mid panel-hide phone-hide">{t('sources.col.type')}</th>
                  <th>{t('sources.col.connection')}</th>
                  {routeColumn && <th className="col-low panel-hide">{t('sources.col.route')}</th>}
                  <th className="num">{t('clusters.col.lastSuccess')}</th>
                  <th>{t('clusters.col.state')}</th>
                </tr>
              </thead>
              {/* A body a group: a link to one cluster or cloud scrolls to its rows. */}
              {collected.map((group) => (
                <tbody key={group.key} id={`source-group:${group.key}`} className="source-group">
                  {group.sources.map((source) => (
                    <SourceRow
                      key={source.id}
                      source={source}
                      group={group}
                      routeColumn={routeColumn}
                      ctx={ctx}
                    />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </Panel>
      )}
      {manual.length > 0 && (
        <Panel id="source-manual" className="source-group" title={t('sources.manual')}>
          <ul className="rows">
            {manual.map((group) => (
              <li key={group.key}>
                <strong className="grow">{group.label}</strong>
                <span className="muted">
                  {t('overview.instances', {
                    count: data.instances.filter(
                      (item) => instanceGroupKey(item, data.sources) === group.key,
                    ).length,
                  })}
                </span>
                <a className="link" href={routeHash('cloud', group.key)}>
                  {t('sources.manage')}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <RoutesPanel ctx={ctx} onChange={ctx.reload} />
    </>
  );
}
