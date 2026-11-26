import type { ReactNode } from 'react';
import { useRouteParam } from '../useRouteParam';
import { groupLabel } from '../groups';
import { t } from '../i18n';
import { groupArrays, jobCount, jobsMissing, listedJobs } from '../domain';
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
        job.array_id,
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
  // Failure records are an exception worth a line only when some logins do not provide them.
  const partialCoverage =
    covered.length > 0 &&
    data.sources.some(
      (source) =>
        source.kind === 'cluster' &&
        source.enabled &&
        inView(source.cluster_id) &&
        !covered.includes(source.id),
    );
  const coverage = covered
    .map((id) => {
      const source = data.sources.find((item) => item.id === id);
      return source ? `${source.name} (${source.username})` : id;
    })
    .join(', ');
  return (
    <>
      {/* Views of the list are page tabs under the title; filters sit in the toolbar. */}
      <div className="page-tabs">
        <Chips
          label={t('jobs.tabs')}
          value={tab}
          onChange={setTab}
          options={[
            // "All" needs no count: the result count below the tabs says it.
            { value: 'all', label: t('filter.all') },
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
      </div>
      <Panel>
        <div className="toolbar">
          <SearchBox ctx={ctx} placeholder={t('jobs.search')} />
          {clusters.length > 1 && (
            <select
              className="chip"
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
          <span className="toolbar-end">
            <ResultCount
              value={
                tab === 'failed'
                  ? covered.length
                    ? failures.length
                    : '—'
                  : count(
                      shown,
                      tab === 'pending' ? 'pending' : tab === 'running' ? 'running' : 'all',
                    )
              }
              trigger={
                // Only a partial count opens whose jobs it leaves out; an exact one is plain text.
                tab !== 'failed' && missing.length > 0 && shown.length > 0
                  ? (value) => (
                      <JobsMissingNote
                        ctx={ctx}
                        missing={missing}
                        staleRows={shown.some((job) => stale.has(job.source_id))}
                        staleCount={shown.filter((job) => stale.has(job.source_id)).length}
                        value={value}
                      />
                    )
                  : undefined
              }
            />
          </span>
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
            {partialCoverage && (
              <p className="panel-note">{t('jobs.failures.coverage', { sources: coverage })}</p>
            )}
          </>
        ) : (
          <>
            <JobsTable
              jobs={groupArrays(shown)}
              groups={groups}
              onOpen={ctx.openJob}
              onOpenArray={ctx.openArray}
              stale={stale}
              empty={
                query ? (
                  <Empty title={t('jobs.empty.query')} />
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
                        <button
                          className="button primary"
                          onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
                        >
                          {t('clusters.add')}
                        </button>
                      ) : undefined
                    }
                  />
                )
              }
            />
          </>
        )}
      </Panel>
      <ActivityPanel
        key={String(ctx.demo)}
        sources={data.sources}
        tools={ctx.tools}
        demo={ctx.demo}
        token={data.token}
        onOpen={ctx.openEvent}
        category="jobs"
        cluster={group}
        query={query}
      />
    </>
  );
}

/** "≥ 36 jobs": the result count of the current view; a partial number is its own trigger. */
function ResultCount({
  value,
  trigger,
}: {
  value: number | string;
  trigger?: (value: number | string) => ReactNode;
}) {
  // The number is its own element (it may be a button); the words around it stay translated.
  const marker = '\u0000';
  const [before, after] = t(value === 1 ? 'jobs.resultCount.one' : 'jobs.resultCount', {
    count: marker,
  }).split(marker);
  return (
    <span className="result-count">
      {before}
      {trigger ? trigger(value) : value}
      {after}
    </span>
  );
}
