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

function GroupPanel({ group, ctx }: { group: Group; ctx: Ctx }) {
  const cluster = group.kind === 'cluster';
  const driver = group.sources[0]?.driver ?? '';
  const info = driverInfo(ctx.drivers, driver, group.kind);
  const primary = primaryField(info);
  // The SSH host gets its own column unless it already identifies the source.
  const sshColumn =
    primary?.key !== 'ssh_alias' && info.fields.some((field) => field.key === 'ssh_alias');
  // An API account's or machine's own name is a column, not a caption.
  const nameColumn = group.sources.some(
    (source) => source.kind !== 'cluster' && source.name !== localized(info.label),
  );
  const routeColumn = group.sources.some((source) => source.node);
  const primaryLabel = primary ? localized(primary.label) : t('sources.col.login');
  return (
    <Panel
      id={`source-group:${group.key}`}
      className="source-group"
      title={
        <span className="with-mark">
          {group.label}
          <span className="muted group-kind">{localized(info.label)}</span>
        </span>
      }
      actions={
        cluster && !ctx.demo ? (
          <button
            className="button small"
            onClick={() => ctx.configure(undefined, { driver, clusterName: group.label })}
          >
            {t('sources.addLogin')}
          </button>
        ) : undefined
      }
    >
      {/* What and its state; what it reads, errors and actions are in the source's pane. */}
      <div className="table-wrap">
        <table className="table stack-on-phone meta-on-phone">
          <thead>
            <tr>
              {nameColumn && <th>{t('sources.col.name')}</th>}
              <th>{primaryLabel}</th>
              {sshColumn && <th>{t('clusters.col.sshHost')}</th>}
              {routeColumn && <th>{t('sources.col.route')}</th>}
              <th className="num">{t('clusters.col.lastSuccess')}</th>
              <th>{t('clusters.col.state')}</th>
            </tr>
          </thead>
          <tbody>
            {group.sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                primary={primary?.key}
                sshColumn={sshColumn}
                nameColumn={nameColumn}
                routeColumn={routeColumn}
                primaryLabel={primaryLabel}
                ctx={ctx}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SourceRow({
  source,
  primary,
  sshColumn,
  nameColumn,
  routeColumn,
  primaryLabel,
  ctx,
}: {
  source: Source;
  primary: string | undefined;
  sshColumn: boolean;
  nameColumn: boolean;
  routeColumn: boolean;
  primaryLabel: string;
  ctx: Ctx;
}) {
  const label = primary ? fieldValue(source, primary) : '';
  const route = ctx.nodes.find((item) => item.id === source.node);
  return (
    <tr
      className="clickable"
      tabIndex={0}
      aria-label={t('attention.diagnosis', { name: label || source.name })}
      onClick={() => ctx.diagnose(source)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) ctx.diagnose(source);
      }}
    >
      {nameColumn && (
        <td>
          <strong>{source.name}</strong>
        </td>
      )}
      <td
        className={primary === 'username' ? '' : 'mono'}
        data-label={nameColumn ? primaryLabel : undefined}
      >
        {nameColumn ? label || source.driver : <strong>{label || source.driver}</strong>}
      </td>
      {sshColumn && (
        <td className="mono" data-label={t('clusters.col.sshHost')}>
          {source.ssh_alias || '—'}
        </td>
      )}
      {routeColumn && (
        <td data-label={t('sources.col.route')}>
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
                <button className="button primary" onClick={() => ctx.configure()}>
                  {t('source.add')}
                </button>
              )
            }
          />
        </Panel>
        <RoutesPanel ctx={ctx} onChange={ctx.reload} />
      </>
    );
  return (
    <>
      <RoutesPanel ctx={ctx} onChange={ctx.reload} />
      {collected.map((group) => (
        <GroupPanel key={group.key} group={group} ctx={ctx} />
      ))}
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
    </>
  );
}
