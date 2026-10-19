import { useState } from 'react';
import { ConnectionChecks } from '../ConnectionChecks';
import { ArrowRight, Plus, RefreshCw } from 'lucide-react';
import type { DriverInfo, Source } from '../types';
import type { Group } from '../groups';
import { instanceGroupKey } from '../groups';
import { formatMessage, localized, t } from '../i18n';
import { driverInfo, fieldValue, primaryField } from '../drivers';
import { money, relativeTime } from '../domain';
import { sourceState } from '../labels';
import { routeHash } from '../routes';
import { Empty, GroupMark, Panel, Status } from '../ui';
import type { Ctx } from './shared';
import { NodesPanel } from './Nodes';

/** What the last successful collection could read; missing items are optional. */
function Capabilities({ source, info }: { source: Source; info: DriverInfo }) {
  return (
    <span className="capabilities">
      {info.checks.map((check) => {
        const state = !source.last_success
          ? 'pending'
          : source.capabilities.includes(check.capability)
            ? 'ok'
            : 'missing';
        const notice = source.warnings?.find(
          (warning) => typeof warning !== 'string' && warning.code === check.warning,
        );
        const title = [
          localized(check.label),
          t(`sources.capability.${state}`),
          notice && formatMessage(notice),
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <span key={check.capability} className={`capability ${state}`} title={title}>
            {check.command}
            {state === 'missing' && ` · ${t('sources.capability.missing')}`}
          </span>
        );
      })}
    </span>
  );
}

function GroupPanel({ group, ctx }: { group: Group; ctx: Ctx }) {
  const cluster = group.kind === 'cluster';
  const driver = group.sources[0]?.driver ?? '';
  const info = driverInfo(ctx.drivers, driver, group.kind);
  const primary = primaryField(info);
  // The SSH host gets its own column unless it already identifies the source.
  const sshColumn =
    primary?.key !== 'ssh_alias' && info.fields.some((field) => field.key === 'ssh_alias');
  return (
    <Panel
      title={
        <span className="with-mark">
          <GroupMark group={group} />
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
            <Plus size={13} /> {t('sources.addLogin')}
          </button>
        ) : undefined
      }
    >
      <div className="table-wrap">
        <table className="table stack-on-phone">
          <thead>
            <tr>
              <th>{primary ? localized(primary.label) : t('sources.col.login')}</th>
              {sshColumn && <th>{t('clusters.col.sshHost')}</th>}
              <th>{t('sources.col.reads')}</th>
              <th className="num">{t('clusters.col.interval')}</th>
              <th className="num">{t('clusters.col.lastSuccess')}</th>
              <th>{t('clusters.col.state')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {group.sources.map((source) => {
              const note = source.error
                ? formatMessage(source.error)
                : source.warnings?.map(formatMessage).join('; ');
              return (
                <SourceRow
                  key={source.id}
                  source={source}
                  info={info}
                  primary={primary?.key}
                  sshColumn={sshColumn}
                  note={note}
                  ctx={ctx}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SourceRow({
  source,
  info,
  primary,
  sshColumn,
  note,
  ctx,
}: {
  source: Source;
  info: DriverInfo;
  primary: string | undefined;
  sshColumn: boolean;
  note: string | undefined;
  ctx: Ctx;
}) {
  const columns = sshColumn ? 7 : 6;
  const [checking, setChecking] = useState(false);
  const label = primary ? fieldValue(source, primary) : '';
  return (
    <>
      <tr className={note ? 'has-note' : ''}>
        <td className={primary === 'username' ? '' : 'mono'}>
          {label || source.driver}
          {source.kind === 'cloud' && source.name !== localized(info.label) && (
            <span className="sub">{source.name}</span>
          )}
          {source.account?.balance != null && (
            <span className="sub">
              {t('sources.balance', {
                amount: money(source.account.balance, source.account.currency),
              })}
            </span>
          )}
          {source.node && (
            <span className="tag via" title={t('nodes.viaHint')}>
              {t('nodes.via', {
                name: ctx.nodes.find((node) => node.id === source.node)?.name ?? source.node,
              })}
            </span>
          )}
        </td>
        {sshColumn && (
          <td className="mono" data-label={t('clusters.col.sshHost')}>
            {source.ssh_alias || '—'}
          </td>
        )}
        <td data-label={t('sources.col.reads')}>
          <Capabilities source={source} info={info} />
        </td>
        <td className="num" data-label={t('clusters.col.interval')}>
          {t('common.minutes', { count: source.interval_minutes })}
        </td>
        <td className="num" data-label={t('clusters.col.lastSuccess')}>
          {relativeTime(source.last_success)}
        </td>
        <td data-label={t('clusters.col.state')}>
          <Status state={sourceState(source)} />
        </td>
        <td className="num nowrap row-actions">
          {!ctx.demo && (
            <>
              <button
                className="icon-button"
                title={t('sources.collectNow')}
                aria-label={t('sources.collectNow')}
                disabled={!source.enabled || source.status === 'syncing'}
                onClick={() => void ctx.collect(source)}
              >
                <RefreshCw size={13} className={source.status === 'syncing' ? 'spin' : ''} />
              </button>
              <button
                className="button small"
                onClick={() => setChecking(!checking)}
                aria-expanded={checking}
              >
                {t('sources.testConnection')}
              </button>
              <button className="button small" onClick={() => ctx.configure(source)}>
                {t('common.configure')}
              </button>
            </>
          )}
        </td>
      </tr>
      {checking && (
        <tr>
          <td colSpan={columns}>
            <ConnectionChecks sourceId={source.id} />
          </td>
        </tr>
      )}
      {note && (
        <tr className="note-row">
          <td colSpan={columns}>
            <span className={source.error ? 'red-text' : 'muted'}>{note}</span>
          </td>
        </tr>
      )}
    </>
  );
}

/** The one place where sources are added, checked and changed. */
export function SourcesPage({ ctx }: { ctx: Ctx }) {
  const { groups, data } = ctx;
  const collected = groups.filter((group) => group.sources.length);
  const manual = groups.filter((group) => !group.sources.length);
  if (!collected.length && !manual.length)
    return (
      <>
        <Panel>
          <Empty
            title={t('settings.noSources')}
            text={t('settings.noSourcesHint')}
            action={
              ctx.demo ? undefined : (
                <button className="button primary" onClick={() => ctx.configure()}>
                  <Plus size={14} /> {t('source.add')}
                </button>
              )
            }
          />
        </Panel>
        <NodesPanel ctx={ctx} onChange={ctx.reload} />
      </>
    );
  return (
    <>
      <p className="page-note">{t('sources.intro')}</p>
      {collected.map((group) => (
        <GroupPanel key={group.key} group={group} ctx={ctx} />
      ))}
      <NodesPanel ctx={ctx} onChange={ctx.reload} />
      {manual.length > 0 && (
        <Panel title={t('sources.manual')}>
          <ul className="rows">
            {manual.map((group) => (
              <li key={group.key}>
                <GroupMark group={group} />
                <div className="grow">
                  <strong>{group.label}</strong>
                  <span className="sub">
                    {t('overview.instances', {
                      count: data.instances.filter(
                        (item) => instanceGroupKey(item, data.sources) === group.key,
                      ).length,
                    })}
                  </span>
                </div>
                <a className="link" href={routeHash('cloud', group.key)}>
                  {t('sources.manage')} <ArrowRight size={13} />
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
