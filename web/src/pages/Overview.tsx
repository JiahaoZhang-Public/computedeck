import { ClockText } from '../data/ClockText';
import { useId, useState } from 'react';
import { X } from 'lucide-react';
import type { Attention } from '../types';
import { UnmeasuredLinks } from './UnmeasuredLinks';
import { attentionText } from '../health';
import { errorText, localized, t } from '../i18n';
import { sortDrivers } from '../drivers';
import {
  groupArrays,
  jobCount,
  jobsMissing,
  listedJobs,
  partialCount,
  relativeTime,
  dateTime,
} from '../domain';
import { routeHash } from '../routes';
import { Empty, Meter, Panel, Stat, Status } from '../ui';
import { ActivityTeaser } from './Activity';
import type { Ctx } from './shared';
import { JobsMissingNote, JobsNotCollected, JobsTable } from './shared';
import { allocationText, groupSummary } from './summary';

export function OverviewPage({ ctx }: { ctx: Ctx }) {
  const { data, demo } = ctx;
  const summary = data.summary;
  // Current jobs first, then the last-known jobs of logins whose job list is not current.
  const { jobs: allJobs, stale } = listedJobs(data);
  const jobRows = groupArrays(allJobs).slice(0, 8);
  const visibleJobs = jobRows.flatMap((row) => ('jobs' in row ? row.jobs : [row]));
  const missingJobs = jobsMissing(data);
  const setupNeeded =
    !demo && !data.sources.length && !data.instances.length && !ctx.attention.length;
  const issues = data.attention_count ?? ctx.attention.length;
  const clusterLogins = data.sources.filter(
    (source) => source.kind === 'cluster' && source.enabled,
  ).length;
  const hasClusters = clusterLogins > 0;
  const jobsKnown = summary.jobs.missing_source_ids.length < clusterLogins;
  const asides =
    demo && !__TEST_PLUGIN_SLOTS__ ? [] : ctx.webPlugins.filter((plugin) => plugin.overview);
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
          value={
            <UnmeasuredLinks
              value={partialCount(summary.allocated, summary.known_allocated)}
              items={summary.unmeasured}
              ctx={ctx}
              label={t('unmeasured.count', {
                count: summary.unmeasured.length + summary.unmonitored,
              })}
              note={
                summary.unmonitored > 0 && t('summary.unmonitored', { count: summary.unmonitored })
              }
            />
          }
        />
        <Stat
          label={t('overview.queued')}
          value={
            <UnmeasuredLinks
              value={partialCount(summary.requested, summary.known_requested)}
              items={hasClusters && summary.requested == null ? summary.queued_unmeasured : []}
              ctx={ctx}
            />
          }
        />
        <Stat
          label={t('overview.running')}
          value={
            <UnmeasuredLinks
              value={partialCount(summary.running, jobsKnown ? summary.known_running : null)}
              items={
                hasClusters && summary.running == null
                  ? summary.queued_unmeasured.filter((item) =>
                      summary.jobs.missing_source_ids.includes(item.subject.id),
                    )
                  : []
              }
              ctx={ctx}
            />
          }
        />
        <Stat label={t('overview.issues')} value={issues} />
      </div>
      <AttentionSection ctx={ctx} issues={issues} />
      <Panel
        title={
          <>
            {t('overview.jobs')}
            {/* A partial count is its own trigger: it opens whose jobs are not counted. */}
            <span className="count">
              {missingJobs.length > 0 && allJobs.length > 0 ? (
                <JobsMissingNote
                  ctx={ctx}
                  missing={missingJobs}
                  staleRows={visibleJobs.some((job) => stale.has(job.source_id))}
                  staleCount={visibleJobs.filter((job) => stale.has(job.source_id)).length}
                  value={jobCount(summary.jobs.known, summary.jobs.missing_source_ids.length)}
                />
              ) : (
                jobCount(summary.jobs.known, summary.jobs.missing_source_ids.length)
              )}
            </span>
          </>
        }
        actions={
          <a className="link" href={routeHash('jobs')}>
            {t('overview.allJobs')}
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
      </Panel>
      <ActivityTeaser key={String(demo)} ctx={ctx} />
      <Panel
        title={t('overview.sources')}
        actions={
          <a className="link" href={routeHash('sources')}>
            {t('overview.manageSources')}
          </a>
        }
      >
        <GroupsTable ctx={ctx} />
      </Panel>
      <p className="panel-note">
        <a className="link" href={routeHash('usage')}>
          {t('usage.view')}
        </a>
      </p>
      {asides.map((plugin) => {
        const Aside = plugin.overview!;
        return (
          <div className="plugin-slot" data-plugin={plugin.id} key={plugin.id}>
            <Aside {...ctx.plugin} />
          </div>
        );
      })}
    </>
  );
}

/** Needs attention: each item can be dismissed; an empty list is one quiet line. */
function AttentionSection({ ctx, issues }: { ctx: Ctx; issues: number }) {
  const active = ctx.attention.filter((item) => !item.muted);
  const muted = ctx.attention.filter((item) => item.muted);
  const restore = muted.length > 0 && (
    <details className="attention-muted">
      <summary>{t('attention.acknowledged', { count: ctx.attention.length - issues })}</summary>
      <ul className="attention">
        {muted.map((item) => (
          <AttentionRow key={item.key} item={item} ctx={ctx} />
        ))}
      </ul>
    </details>
  );
  if (!active.length)
    return (
      <section className="attention-quiet" id="attention" tabIndex={-1}>
        <p>{t('overview.attention.none')}</p>
        {restore}
      </section>
    );
  return (
    <Panel title={t('overview.attention')} id="attention" tabIndex={-1}>
      <ul className="attention">
        {active.map((item) => (
          <AttentionRow key={item.key} item={item} ctx={ctx} />
        ))}
      </ul>
      {restore}
    </Panel>
  );
}

function AttentionRow({ item, ctx }: { item: Attention; ctx: Ctx }) {
  const labelId = useId();
  const title = attentionText(item, ctx.tools);
  const [busy, setBusy] = useState(false);
  async function update(action: 'acknowledge' | 'clear', from: HTMLElement) {
    // Focus moves to the next item (or the previous one, or the section) once this one leaves.
    const row = from.closest('li');
    const next = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector('button');
    setBusy(true);
    try {
      await ctx.muteAttention(item, action);
      if (action === 'acknowledge')
        ctx.notify(t('attention.acknowledgedToast'), 'ok', {
          label: t('layer.undo'),
          undo: true,
          run: () =>
            void ctx
              .muteAttention(item, 'clear')
              .catch((error) => ctx.notify(errorText(error, 'error.save'), 'error')),
        });
      else ctx.notify(t('attention.unmutedToast'));
      (next?.isConnected ? next : document.getElementById('attention'))?.focus();
    } catch (error) {
      ctx.notify(errorText(error, 'error.save'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <li>
      {/* One line: what, then when. The cause, figures and times are in the detail it opens. */}
      <button className="attention-open" onClick={() => ctx.openAttention(item)}>
        <span className={`dot ${item.severity === 'error' ? 'red' : 'amber'}`} />
        <strong id={labelId}>{title}</strong>
        <span className="attention-age">
          <ClockText>
            {() =>
              item.muted
                ? item.muted.state === 'snoozed'
                  ? t('attention.snoozedUntil', { time: dateTime(item.muted.until) })
                  : t('attention.untilChanges')
                : relativeTime(item.since ?? item.observed_at)
            }
          </ClockText>
        </span>
      </button>
      {/* A service fault cannot be dismissed; everything else has one control. */}
      {item.mutable !== false &&
        (item.muted ? (
          <button
            className="button small quiet"
            disabled={busy}
            aria-describedby={labelId}
            onClick={(event) => void update('clear', event.currentTarget)}
          >
            {t('attention.unmute')}
          </button>
        ) : (
          <button
            className="icon-button attention-dismiss"
            disabled={busy}
            aria-label={t('attention.dismiss', { title })}
            title={t('attention.dismiss', { title })}
            onClick={(event) => void update('acknowledge', event.currentTarget)}
          >
            <X size={14} />
          </button>
        ))}
    </li>
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
    title: string;
    text: string;
    open: () => void;
  }[] = [
    {
      key: 'cluster',
      title: t('setup.cluster'),
      text: names('cluster'),
      open: () => ctx.configure(undefined, { kind: 'cluster' }),
    },
    {
      key: 'cloud',
      title: t('setup.cloud'),
      text: names('cloud'),
      open: () => ctx.configure(undefined, { kind: 'cloud' }),
    },
    {
      key: 'machine',
      title: t('setup.machine'),
      text: t('setup.machineHint'),
      // Without the SSH driver a machine can still be entered by hand.
      open: () => (ssh ? ctx.configure(undefined, { driver: 'ssh' }) : ctx.addInstance()),
    },
  ];
  return (
    <section className="panel setup">
      <h2>{t('setup.title')}</h2>
      <div className="type-cards setup-cards">
        {choices.map((choice) => (
          <button key={choice.key} className="type-card" onClick={choice.open}>
            <strong>{choice.title}</strong>
            <span>{choice.text}</span>
          </button>
        ))}
      </div>
      <button className="link" onClick={ctx.toggleDemo}>
        {t('setup.demo')}
      </button>
    </section>
  );
}

/** GPUs in use for one row: "≥ n" when part of the use is unknown, never a false 0. */
function GroupsTable({ ctx }: { ctx: Ctx }) {
  const { data, groups } = ctx;
  if (!groups.length)
    return (
      <Empty
        title={t('overview.sources.empty')}
        action={
          ctx.demo ? undefined : (
            <button className="button" onClick={() => ctx.configure()}>
              {t('source.add')}
            </button>
          )
        }
      />
    );
  return (
    <div className="table-wrap">
      <table className="table stack-on-phone meta-on-phone">
        <thead>
          <tr>
            <th>{t('overview.col.source')}</th>
            <th className="num">{t('overview.col.allocated')}</th>
            <th>{t('overview.col.capacity')}</th>
            <th>{t('overview.col.state')}</th>
            <th className="num col-mid">{t('overview.col.updated')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const row = groupSummary(data, group);
            const { nodes } = row;
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
                  <strong>{group.label}</strong>
                </td>
                <td className="num key" data-label={t('overview.col.allocated')}>
                  <UnmeasuredLinks
                    value={partialCount(row.scoped.allocated, row.scoped.known_allocated)}
                    items={row.scoped.unmeasured}
                    ctx={ctx}
                  />
                </td>
                <td data-label={t('overview.col.capacity')}>
                  {cluster && nodes.nodes > 0 ? (
                    <Meter value={nodes.ratio} text={allocationText(nodes)} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td data-label={t('overview.col.state')}>
                  <Status state={row.state} />
                </td>
                <td className="num muted col-mid" data-label={t('overview.col.updated')}>
                  <ClockText>{() => (row.updated ? relativeTime(row.updated) : '—')}</ClockText>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
