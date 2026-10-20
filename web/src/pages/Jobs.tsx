import { useRouteParam } from '../useRouteParam';
import { ArrowRight } from 'lucide-react';
import { groupLabel } from '../groups';
import { t } from '../i18n';
import { jobCount, jobsMissing, listedJobs, relativeTime } from '../domain';
import { routeHash } from '../routes';
import { Chips, Empty, Panel } from '../ui';
import type { Ctx } from './shared';
import { ActivityPanel } from './Activity';
import { FailuresTable, JobsMissingNote, JobsNotCollected, JobsTable, SearchBox } from './shared';
import { matches } from './util';

export function JobsPage({ ctx }: { ctx: Ctx }) {
  const { data, group, query, groups } = ctx;
  const [requestedTab, setTab] = useRouteParam('state', 'all');
  const tab = ['all', 'running', 'pending', 'failed'].includes(requestedTab) ? requestedTab : 'all';
  const clusters = groups.filter((item) => item.kind === 'cluster');
  const inView = (clusterId: string) => group === 'all' || clusterId === group;
  // Logins without a current job list: their jobs are unknown, so counts are lower bounds.
  const missing = jobsMissing(data).filter((source) => inView(source.cluster_id));
  const collected = data.sources.some(
    (source) =>
      source.enabled &&
      source.kind === 'cluster' &&
      inView(source.cluster_id) &&
      !missing.includes(source),
  );
  const { jobs: listed, stale } = listedJobs(data);
  const scoped = listed.filter(
    (job) =>
      inView(job.cluster_id) &&
      matches(
        query,
        job.name,
        job.id,
        job.user,
        job.qos,
        job.partition,
        job.node,
        groupLabel(groups, job.cluster_id),
      ),
  );
  const runningIds = new Set(data.summary.jobs.running_ids);
  const pendingIds = new Set(data.summary.jobs.pending_ids);
  const running = scoped.filter((job) => runningIds.has(job.id));
  const pending = scoped.filter((job) => pendingIds.has(job.id));
  const covered = data.failure_history_sources ?? [];
  const failures = (data.recent_failures ?? []).filter(
    (job) =>
      (group === 'all' || job.cluster_id === group) &&
      matches(query, job.name, job.id, job.user, job.qos),
  );
  const shown = tab === 'running' ? running : tab === 'pending' ? pending : scoped;
  const summary = group === 'all' ? data.summary : data.summary.groups[group];
  const count = (jobs: typeof scoped, state: 'all' | 'running' | 'pending') => {
    if (!query && summary) {
      const known =
        state === 'all'
          ? summary.jobs.known
          : state === 'running'
            ? summary.known_running
            : summary.known_pending;
      return jobCount(known, summary.jobs.missing_source_ids.length);
    }
    return jobCount(jobs.filter((job) => !stale.has(job.source_id)).length, missing.length);
  };
  const hasClusters = data.sources.some((source) => source.kind === 'cluster' && source.enabled);
  const coverage = covered
    .map((id) => {
      const source = data.sources.find((item) => item.id === id);
      return source ? `${source.name} (${source.username})` : id;
    })
    .join(', ');
  return (
    <>
      <Panel>
        <div className="toolbar">
          <Chips
            label={t('jobs.tabs')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: t('filter.all'), count: count(scoped, 'all') },
              { value: 'running', label: t('status.RUNNING'), count: count(running, 'running') },
              { value: 'pending', label: t('status.PENDING'), count: count(pending, 'pending') },
              {
                value: 'failed',
                label: t('jobs.failed24h'),
                // Without a source of failure records, the number of failures is unknown.
                count: covered.length ? failures.length : '—',
              },
            ]}
          />
          <div className="toolbar-end">
            {clusters.length > 1 && (
              <select
                className="select"
                value={group}
                onChange={(event) => ctx.setGroup(event.target.value)}
                aria-label={t('jobs.byCluster')}
              >
                <option value="all">{t('jobs.allClusters')}</option>
                {clusters.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
            <SearchBox ctx={ctx} placeholder={t('jobs.search')} />
          </div>
        </div>
        {tab === 'failed' ? (
          <>
            {failures.length ? (
              <FailuresTable jobs={failures} groups={groups} onOpen={ctx.openJob} />
            ) : (
              <Empty
                title={covered.length ? t('jobs.failures.none') : t('jobs.failures.unavailable')}
                text={covered.length ? undefined : t('jobs.failures.unavailableHint')}
              />
            )}
            <p className="panel-note">
              {covered.length
                ? t('jobs.failures.coverage', { sources: coverage })
                : t('jobs.failures.noCoverage')}
              {data.failure_history_observed_at &&
                ' ' + t('common.updated', { time: relativeTime(data.failure_history_observed_at) })}
            </p>
          </>
        ) : (
          <>
            <JobsTable
              jobs={shown}
              groups={groups}
              onOpen={ctx.openJob}
              stale={stale}
              empty={
                query ? (
                  <Empty title={t('jobs.empty.query')} text={t('common.tryAnother')} />
                ) : missing.length ? (
                  <JobsNotCollected groups={groups} missing={missing} partial={collected} />
                ) : (
                  <Empty
                    title={t('jobs.empty')}
                    text={
                      !hasClusters
                        ? t('jobs.empty.unconfigured')
                        : scoped.length || group !== 'all'
                          ? t('jobs.empty.filtered')
                          : undefined
                    }
                    action={
                      !hasClusters && !ctx.demo ? (
                        <a className="button" href={routeHash('settings')}>
                          {t('common.toSettings')} <ArrowRight size={13} />
                        </a>
                      ) : undefined
                    }
                  />
                )
              }
            />
            {missing.length > 0 && shown.length > 0 && (
              <JobsMissingNote
                groups={groups}
                missing={missing}
                staleRows={shown.some((job) => stale.has(job.source_id))}
                staleCount={shown.filter((job) => stale.has(job.source_id)).length}
              />
            )}
            <p className="panel-note">{t('jobs.note')}</p>
          </>
        )}
      </Panel>
      <ActivityPanel demo={ctx.demo} token={data.token} />
    </>
  );
}
