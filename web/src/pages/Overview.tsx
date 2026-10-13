import { ArrowRight, ChevronRight, Cloud, Plus, Server, Terminal } from 'lucide-react';
import { localized, t } from '../i18n';
import { sortDrivers } from '../drivers';
import {
  jobCount,
  jobsMissing,
  listedJobs,
  money,
  partialCount,
  relativeTime,
  summarize,
} from '../domain';
import { connectedSource } from '../labels';
import { routeHash } from '../routes';
import { Empty, GroupMark, Meter, Panel, Stat, Status } from '../ui';
import { HistoryPanel } from './HistoryPanel';
import type { Ctx } from './shared';
import { FailuresTable, JobsMissingNote, JobsNotCollected, JobsTable } from './shared';
import { recentlyReachable } from './util';
import { groupSummary, instanceCount } from './summary';

export function OverviewPage({ ctx }: { ctx: Ctx }) {
  const { data, demo } = ctx;
  const summary = summarize(data);
  // Current jobs first, then the last-known jobs of logins whose job list is not current.
  const { jobs: allJobs, stale } = listedJobs(data);
  const missingJobs = jobsMissing(data.sources);
  const failures = data.recent_failures ?? [];
  const setupNeeded = !demo && !data.sources.length && !data.instances.length;
  const issues = ctx.attention.filter((item) => item.tone !== 'gray').length;
  const connected = data.sources.some(connectedSource) || data.instances.some(recentlyReachable);
  const jobsKnown = summary.knownRequested != null || summary.knownRunning > 0;
  const clusterLogins = data.sources.filter(
    (source) => source.kind === 'cluster' && source.enabled,
  ).length;
  const hasClusters = clusterLogins > 0;
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
          value={partialCount(summary.allocated, summary.knownAllocated)}
          hint={
            summary.knownAllocated == null
              ? t('overview.allocated.none')
              : summary.allocated == null
                ? t('overview.allocated.partial', { count: summary.unknownAllocationSources })
                : t('overview.allocated.complete')
          }
        />
        <Stat
          label={t('overview.queued')}
          value={partialCount(summary.requested, summary.knownRequested)}
          hint={
            !hasClusters
              ? t('overview.running.none')
              : summary.requested == null
                ? t('overview.queued.partial')
                : t('overview.queued.jobs', { count: summary.pending })
          }
        />
        <Stat
          label={t('overview.running')}
          value={summary.running ?? (jobsKnown ? summary.knownRunning : '—')}
          hint={
            summary.running != null
              ? t('overview.running.complete')
              : jobsKnown
                ? t('overview.running.partial')
                : t('overview.running.none')
          }
        />
        <Stat
          label={t('overview.issues')}
          value={issues}
          hint={
            issues
              ? t('overview.issues.some')
              : connected
                ? t('overview.issues.none')
                : t('overview.issues.unconfigured')
          }
        />
      </div>
      <div className="grid wide-narrow">
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
        <Panel title={t('overview.attention')} count={ctx.attention.length} id="attention">
          {ctx.attention.length ? (
            <ul className="attention">
              {ctx.attention.map((item) => (
                <li key={item.id}>
                  <button onClick={item.action}>
                    <span className={`dot ${item.tone}`} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.text}</small>
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
      </div>
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
      <Panel
        title={t('overview.jobs')}
        count={jobCount(
          allJobs.filter((job) => !stale.has(job.source_id)).length,
          missingJobs.length,
        )}
        actions={
          <a className="link" href={routeHash('jobs')}>
            {t('overview.allJobs')} <ArrowRight size={13} />
          </a>
        }
      >
        <JobsTable
          jobs={allJobs.slice(0, 8)}
          groups={ctx.groups}
          onOpen={ctx.openJob}
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
            staleRows={allJobs.slice(0, 8).some((job) => stale.has(job.source_id))}
          />
        )}
      </Panel>
      {failures.length > 0 && (
        <Panel title={t('overview.failures')} count={failures.length}>
          <FailuresTable jobs={failures.slice(0, 5)} groups={ctx.groups} />
        </Panel>
      )}
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
function allocatedCell(summary: ReturnType<typeof summarize>) {
  if (summary.allocated != null) return summary.allocated;
  return (
    <span
      className={summary.knownAllocated ? '' : 'muted'}
      title={t('overview.allocated.unknownCell')}
    >
      {summary.knownAllocated ? `≥ ${summary.knownAllocated}` : '—'}
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
      <table className="table">
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
            const cluster = group.kind === 'cluster';
            const open = () => ctx.navigate(cluster ? 'resources' : 'cloud', group.key);
            return (
              <tr
                key={group.key}
                className="clickable"
                tabIndex={0}
                onClick={open}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') open();
                }}
              >
                <td>
                  <span className="with-mark">
                    <GroupMark group={group} />
                    <strong>{group.label}</strong>
                  </span>
                </td>
                <td className="muted">
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
                <td className="num">{allocatedCell(row.scoped)}</td>
                <td>
                  {cluster ? (
                    row.nodes.capacity != null ? (
                      <Meter
                        value={row.nodes.ratio}
                        text={t('overview.load.allocated', {
                          allocated: row.nodes.allocated ?? '?',
                          capacity: row.nodes.capacity,
                        })}
                      />
                    ) : (
                      <span className="muted">—</span>
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
                <td>
                  <Status state={row.state} />
                </td>
                <td className="num muted">{row.updated ? relativeTime(row.updated) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
