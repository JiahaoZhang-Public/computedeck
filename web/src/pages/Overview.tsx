import type { Summary } from '../types';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { attentionText, nextAttemptText } from '../health';
import { ArrowRight, ChevronRight, Cloud, Plus, Server, Terminal } from 'lucide-react';
import { formatMessage, localized, t } from '../i18n';
import { sortDrivers } from '../drivers';
import {
  groupArrays,
  jobCount,
  jobsMissing,
  listedJobs,
  money,
  partialCount,
  relativeTime,
  dateTime,
} from '../domain';
import { connectedSource } from '../labels';
import { routeHash } from '../routes';
import { Empty, GroupMark, Meter, Panel, Stat, Status } from '../ui';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { FailuresTable, JobsMissingNote, JobsNotCollected, JobsTable } from './shared';
import { recentlyReachable } from './util';
import { capacityText, groupSummary, instanceCount } from './summary';

export function OverviewPage({ ctx }: { ctx: Ctx }) {
  const { data, demo } = ctx;
  const summary = data.summary;
  // Current jobs first, then the last-known jobs of logins whose job list is not current.
  const { jobs: allJobs, stale } = listedJobs(data);
  const jobRows = groupArrays(allJobs).slice(0, 8);
  const visibleJobs = jobRows.flatMap((row) => ('jobs' in row ? row.jobs : [row]));
  const missingJobs = jobsMissing(data);
  const failures = data.recent_failures ?? [];
  const setupNeeded =
    !demo && !data.sources.length && !data.instances.length && !ctx.attention.length;
  const issues = ctx.attention.length;
  const connected = data.sources.some(connectedSource) || data.instances.some(recentlyReachable);
  const clusterLogins = data.sources.filter(
    (source) => source.kind === 'cluster' && source.enabled,
  ).length;
  const hasClusters = clusterLogins > 0;
  const jobsKnown = summary.jobs.missing_source_ids.length < clusterLogins;
  const asides = demo ? [] : ctx.webPlugins.filter((plugin) => plugin.overview);
  // Before anything is connected the dashboard has nothing to say; show how to start.
  if (setupNeeded) return <SetupGuide ctx={ctx} />;
  const waiting =
    !demo &&
    data.sources.length > 0 &&
    data.sources.every((source) => !source.last_success && source.status !== 'error');
  return (
    <>
      {waiting && (
        <div className="callout amber first-collection">
          <strong>{t('overview.waiting')}</strong>
          <span>{t('overview.waitingHint')}</span>
        </div>
      )}
      <div className="stats">
        <Stat
          label={t('overview.allocated')}
          value={partialCount(summary.allocated, summary.known_allocated)}
          hint={
            <>
              {summary.unmeasured.length ? (
                <UnmeasuredLinks items={summary.unmeasured} ctx={ctx} />
              ) : summary.known_allocated == null ? (
                t('overview.allocated.none')
              ) : (
                t('overview.allocated.complete')
              )}
              {summary.unmonitored > 0 && (
                <span className="sub">
                  {t('summary.unmonitored', { count: summary.unmonitored })}
                </span>
              )}
            </>
          }
        />
        <Stat
          label={t('overview.queued')}
          value={partialCount(summary.requested, summary.known_requested)}
          hint={
            !hasClusters ? (
              t('overview.running.none')
            ) : summary.requested == null ? (
              <UnmeasuredLinks items={summary.queued_unmeasured} ctx={ctx} />
            ) : (
              t('overview.queued.jobs', { count: summary.pending })
            )
          }
        />
        <Stat
          label={t('overview.running')}
          value={partialCount(summary.running, jobsKnown ? summary.known_running : null)}
          hint={
            summary.running != null ? (
              t('overview.running.complete')
            ) : hasClusters ? (
              <UnmeasuredLinks
                items={summary.queued_unmeasured.filter((item) =>
                  summary.jobs.missing_source_ids.includes(item.subject.id),
                )}
                ctx={ctx}
              />
            ) : (
              t('overview.running.none')
            )
          }
        />
        <Stat
          label={t('overview.issues')}
          value={issues}
          hint={
            issues ? (
              <a
                className="link"
                href="#attention"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById('attention')?.focus();
                }}
              >
                {t('overview.issues.some')}
              </a>
            ) : connected ? (
              t('overview.issues.none')
            ) : (
              t('overview.issues.unconfigured')
            )
          }
        />
      </div>
      <Panel
        title={t('overview.attention')}
        count={ctx.attention.length}
        id="attention"
        tabIndex={-1}
      >
        {ctx.attention.length ? (
          <ul className="attention">
            {ctx.attention.map((item) => (
              <li key={item.key}>
                <button onClick={() => ctx.openAttention(item)}>
                  <span className={`dot ${item.severity === 'error' ? 'red' : 'amber'}`} />
                  <span>
                    <strong>{attentionText(item, ctx.tools)}</strong>
                    {item.details.map((detail, index) => (
                      <small key={index}>{formatMessage(detail)}</small>
                    ))}
                    <small>
                      {item.since
                        ? t('attention.since', {
                            time: dateTime(item.since),
                            age: relativeTime(item.since),
                          })
                        : item.observed_at
                          ? t(
                              item.kind === 'instance_ssh_failed'
                                ? 'attention.checked'
                                : 'attention.lastSeen',
                              {
                                time: dateTime(item.observed_at),
                                age: relativeTime(item.observed_at),
                              },
                            )
                          : t('attention.sinceUnknown')}
                      {item.next_attempt &&
                        ` · ${nextAttemptText(
                          item.next_attempt,
                          item.subject.kind === 'source' &&
                            (data.collecting?.includes(item.subject.id) ||
                              data.sources.some(
                                (source) =>
                                  source.id === item.subject.id && source.status === 'syncing',
                              )),
                        )}`}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-note">{t('overview.attention.none')}</p>
        )}
      </Panel>
      <Panel
        title={t('overview.jobs')}
        count={jobCount(summary.jobs.known, summary.jobs.missing_source_ids.length)}
        actions={
          <a className="link" href={routeHash('jobs')}>
            {t('overview.allJobs')} <ArrowRight size={13} />
          </a>
        }
      >
        <JobsTable
          jobs={jobRows}
          groups={ctx.groups}
          onOpen={ctx.openJob}
          onOpenArray={ctx.openArray}
          stale={stale}
          empty={
            missingJobs.length ? (
              <JobsNotCollected
                groups={ctx.groups}
                missing={missingJobs}
                partial={hasClusters && missingJobs.length < clusterLogins}
              />
            ) : (
              <Empty
                title={t('overview.jobs.empty')}
                text={hasClusters ? undefined : t('overview.jobs.emptyHint')}
              />
            )
          }
        />
        {missingJobs.length > 0 && allJobs.length > 0 && (
          <JobsMissingNote
            groups={ctx.groups}
            missing={missingJobs}
            staleRows={visibleJobs.some((job) => stale.has(job.source_id))}
            staleCount={visibleJobs.filter((job) => stale.has(job.source_id)).length}
          />
        )}
      </Panel>
      {failures.length > 0 && (
        <Panel title={t('overview.failures')} count={failures.length}>
          <FailuresTable jobs={failures.slice(0, 5)} groups={ctx.groups} onOpen={ctx.openJob} />
        </Panel>
      )}
      <Panel
        title={t('overview.sources')}
        actions={
          <a className="link" href={routeHash('sources')}>
            {t('overview.manageSources')} <ArrowRight size={13} />
          </a>
        }
      >
        <GroupsTable ctx={ctx} />
      </Panel>
      <div className={`grid ${asides.length ? 'wide-narrow' : ''}`}>
        <HistoryPanel day={data.history} demo={demo} />
        {asides.length > 0 && (
          <div className="stack">
            {asides.map((plugin) => {
              const Aside = plugin.overview!;
              return <Aside key={plugin.id} {...ctx.plugin} />;
            })}
          </div>
        )}
      </div>
    </>
  );
}

function SetupGuide({ ctx }: { ctx: Ctx }) {
  const names = (kind: 'cluster' | 'cloud') =>
    sortDrivers(ctx.drivers)
      .filter((driver) => driver.kind === kind && driver.name !== 'ssh')
      .map((driver) => localized(driver.label))
      .join(' · ');
  const ssh = ctx.drivers.some((driver) => driver.name === 'ssh');
  const choices: {
    key: string;
    icon: typeof Server;
    title: string;
    text: string;
    open: () => void;
  }[] = [
    {
      key: 'cluster',
      icon: Server,
      title: t('setup.cluster'),
      text: names('cluster'),
      open: () => ctx.configure(undefined, { kind: 'cluster' }),
    },
    {
      key: 'cloud',
      icon: Cloud,
      title: t('setup.cloud'),
      text: names('cloud'),
      open: () => ctx.configure(undefined, { kind: 'cloud' }),
    },
    {
      key: 'machine',
      icon: Terminal,
      title: t('setup.machine'),
      text: t('setup.machineHint'),
      // Without the SSH driver a machine can still be entered by hand.
      open: () => (ssh ? ctx.configure(undefined, { driver: 'ssh' }) : ctx.addInstance()),
    },
  ];
  return (
    <section className="panel setup">
      <h2>{t('setup.title')}</h2>
      <p>{t('setup.intro')}</p>
      <div className="type-cards setup-cards">
        {choices.map((choice) => (
          <button key={choice.key} className="type-card" onClick={choice.open}>
            <choice.icon size={18} />
            <strong>{choice.title}</strong>
            <span>{choice.text}</span>
          </button>
        ))}
      </div>
      <p className="panel-note">
        {t('setup.refresh')}{' '}
        <button className="link" onClick={ctx.toggleDemo}>
          {t('setup.demo')}
        </button>
      </p>
    </section>
  );
}

/** GPUs in use for one row: "≥ n" when part of the use is unknown, never a false 0. */
function allocatedCell(summary: Summary, ctx: Ctx) {
  if (summary.allocated != null) return summary.allocated;
  return (
    <span
      className={summary.known_allocated ? '' : 'muted'}
      title={t('overview.allocated.unknownCell')}
    >
      {summary.known_allocated ? `≥ ${summary.known_allocated}` : '—'}
      <UnmeasuredLinks items={summary.unmeasured} ctx={ctx} />
    </span>
  );
}

function GroupsTable({ ctx }: { ctx: Ctx }) {
  const { data, groups } = ctx;
  if (!groups.length)
    return (
      <Empty
        title={t('overview.sources.empty')}
        action={
          ctx.demo ? undefined : (
            <button className="button" onClick={() => ctx.configure()}>
              <Plus size={14} /> {t('source.add')}
            </button>
          )
        }
      />
    );
  return (
    <div className="table-wrap">
      <table className="table stack-on-phone">
        <thead>
          <tr>
            <th>{t('overview.col.source')}</th>
            <th>{t('overview.col.accounts')}</th>
            <th className="num">{t('overview.col.allocated')}</th>
            <th>{t('overview.col.load')}</th>
            <th>{t('overview.col.state')}</th>
            <th className="num">{t('overview.col.updated')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const row = groupSummary(data, group);
            const capacity = capacityText(row.nodes, row.state);
            const cluster = group.kind === 'cluster';
            const open = () => ctx.navigate(cluster ? 'resources' : 'cloud', group.key);
            return (
              <tr
                key={group.key}
                className="clickable"
                tabIndex={0}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) open();
                }}
              >
                <td>
                  <span className="with-mark">
                    <GroupMark group={group} />
                    <strong>{group.label}</strong>
                  </span>
                </td>
                <td className="muted" data-label={t('overview.col.accounts')}>
                  {cluster
                    ? group.sources
                        .map((source) => source.username)
                        .filter(Boolean)
                        .join(', ') || '—'
                    : [
                        instanceCount(group.sources, row.instances.length),
                        ...group.sources
                          .filter((source) => source.account?.balance != null)
                          .map((source) =>
                            t('sources.balance', {
                              amount: money(source.account!.balance!, source.account!.currency),
                            }),
                          ),
                      ].join(' · ')}
                </td>
                <td className="num" data-label={t('overview.col.allocated')}>
                  {allocatedCell(row.scoped, ctx)}
                </td>
                <td data-label={t('overview.col.load')}>
                  {cluster ? (
                    row.nodes.nodes === 0 ? (
                      <span className="muted">—</span>
                    ) : capacity.outage ? (
                      <span className={capacity.tone}>{capacity.text}</span>
                    ) : (
                      <span>
                        <Meter
                          value={row.nodes.ratio}
                          text={<span className={capacity.tone}>{capacity.text}</span>}
                        />
                        <span className="sub muted">{capacity.detail}</span>
                      </span>
                    )
                  ) : row.scoped.utilization != null ? (
                    <Meter
                      value={row.scoped.utilization}
                      text={t('overview.load.utilization', {
                        value: Math.round(row.scoped.utilization),
                      })}
                    />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label={t('overview.col.state')}>
                  <Status state={row.state} />
                </td>
                <td className="num muted" data-label={t('overview.col.updated')}>
                  {row.updated ? relativeTime(row.updated) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
