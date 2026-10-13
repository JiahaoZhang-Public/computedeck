import type { ReactNode, RefObject } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import type {
  CollectionNode,
  Dashboard,
  DriverInfo,
  FailedJob,
  Health,
  Instance,
  Job,
  Source,
  Tool,
} from '../types';
import type { SourcePreset } from '../forms';
import type { Group } from '../groups';
import { groupLabel, sourceList } from '../groups';
import type { Filter, Page } from '../routes';
import { routeHash } from '../routes';
import type { Locale } from '../i18n';
import { t } from '../i18n';
import type { PluginProps, WebPlugin } from '../plugins';
import { dateTime, jobGpuResources, relativeTime } from '../domain';
import { Chips, Empty, Status } from '../ui';

export type Attention = {
  id: string;
  tone: 'red' | 'amber' | 'gray';
  title: string;
  text: string;
  action: () => void;
};

export type Ctx = {
  data: Dashboard;
  groups: Group[];
  demo: boolean;
  remote: boolean;
  /** Display name of the service host in remote mode. */
  serverName: string;
  busy: boolean;
  group: Filter;
  setGroup: (group: Filter) => void;
  query: string;
  setQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  attention: Attention[];
  health: Health | null;
  locale: Locale;
  changeLocale: (locale: Locale) => void;
  plugin: PluginProps;
  navigate: (page: Page, group?: Filter) => void;
  /** Web plugins whose server plugin is on (built in or loaded at run time). */
  webPlugins: WebPlugin[];
  /** Descriptions of the installed drivers. */
  drivers: DriverInfo[];
  /** Machines that collect sources for this service over SSH. */
  nodes: CollectionNode[];
  /** Fetch the dashboard, tools and machines again. */
  reload: () => Promise<void>;
  /** Plugins in the Toolbox, on or off. */
  tools: Tool[];
  /** Switch a tool or save its settings; rejects with the server's message. */
  updateTool: (id: string, body: unknown) => Promise<Tool>;
  /** Open the source form: edit `source`, or add one, optionally of a driver, cluster or kind. */
  configure: (source?: Source, preset?: SourcePreset) => void;
  /** Collect one source now. */
  collect: (source: Source) => Promise<void>;
  addInstance: () => void;
  showSSH: () => void;
  openJob: (job: Job) => void;
  openInstance: (item: Instance) => void;
  copy: (text: string) => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  backup: () => Promise<void>;
  toggleDemo: () => void;
};

export function SearchBox({ ctx, placeholder }: { ctx: Ctx; placeholder: string }) {
  return (
    <label className="search">
      <Search size={14} />
      <input
        ref={ctx.searchRef}
        value={ctx.query}
        onChange={(event) => ctx.setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {ctx.query ? (
        <button
          className="icon-button"
          aria-label={t('search.clear')}
          onClick={() => ctx.setQuery('')}
        >
          <X size={12} />
        </button>
      ) : (
        <kbd>⌘K</kbd>
      )}
    </label>
  );
}

export function GroupFilter({ ctx, options }: { ctx: Ctx; options: Group[] }) {
  if (options.length < 2) return null;
  return (
    <Chips
      label={t('filter.byGroup')}
      value={ctx.group}
      onChange={ctx.setGroup}
      options={[
        { value: 'all', label: t('filter.all') },
        ...options.map((item) => ({ value: item.key, label: item.label })),
      ]}
    />
  );
}

/**
 * Shown instead of "No jobs" while cluster logins have no current job list. `partial`: other
 * logins in view do have one.
 */
export function JobsNotCollected({
  groups,
  missing,
  partial,
}: {
  groups: Group[];
  missing: Source[];
  partial: boolean;
}) {
  return (
    <Empty
      title={partial ? t('jobs.missing.titleSome') : t('jobs.missing.title')}
      text={t('jobs.missing.text', { sources: sourceList(groups, missing) })}
      action={
        <a className="link" href={routeHash('sources')}>
          {t('overview.manageSources')} <ArrowRight size={13} />
        </a>
      }
    />
  );
}

/** Under a job list that is partly unknown: whose jobs are missing, and what stale rows are. */
export function JobsMissingNote({
  groups,
  missing,
  staleRows,
}: {
  groups: Group[];
  missing: Source[];
  staleRows: boolean;
}) {
  return (
    <p className="panel-note">
      {t('jobs.missing.text', { sources: sourceList(groups, missing) })}
      {staleRows && ` ${t('jobs.missing.stale')}`}
    </p>
  );
}

export function JobsTable({
  jobs,
  groups,
  onOpen,
  empty,
  stale,
}: {
  jobs: Job[];
  groups: Group[];
  onOpen: (job: Job) => void;
  empty: ReactNode;
  /** Logins whose job list is not current; their rows are last-known jobs, tagged as such. */
  stale?: Set<string>;
}) {
  if (!jobs.length) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="table jobs-table">
        <thead>
          <tr>
            <th>{t('jobs.col.job')}</th>
            <th>{t('jobs.col.clusterQos')}</th>
            <th className="num">GPU</th>
            <th className="num">CPU</th>
            <th>{t('jobs.col.state')}</th>
            <th>{t('jobs.col.nodeReason')}</th>
            <th className="num">{t('jobs.col.elapsed')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const gpu = jobGpuResources(job);
            const pending = job.state.toUpperCase() === 'PENDING';
            const old = !!stale?.has(job.source_id);
            return (
              <tr
                key={job.id}
                className={`clickable ${old ? 'stale-row' : ''}`}
                tabIndex={0}
                onClick={() => onOpen(job)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onOpen(job);
                }}
              >
                <td>
                  <strong className="truncate" title={job.name}>
                    {job.name}
                  </strong>
                  <span className="sub mono">
                    {job.id} · {job.user}
                  </span>
                  {old && (
                    <span className="sub">
                      <span className="tag amber">
                        {t('cloud.staleSince', { time: relativeTime(job.observed_at) })}
                      </span>
                    </span>
                  )}
                </td>
                <td>
                  {groupLabel(groups, job.cluster_id)}
                  <span className="sub">{job.qos || '—'}</span>
                </td>
                <td className="num">
                  {pending ? (
                    <span className="muted">
                      {t('jobs.requested', { count: gpu.requested ?? '?' })}
                    </span>
                  ) : (
                    (gpu.allocated ?? '—')
                  )}
                  <span className="sub">{job.gpu_type || ''}</span>
                </td>
                <td className="num">{job.cpu_count ?? '—'}</td>
                <td>
                  <Status state={job.state} />
                </td>
                <td>
                  <span className="clamp" title={(pending ? job.reason : job.node) ?? ''}>
                    {pending ? job.reason || t('jobs.waiting') : job.node || '—'}
                  </span>
                </td>
                <td className="num mono">
                  {job.elapsed || '—'}
                  <span className="sub" title={job.observed_at ?? ''}>
                    {relativeTime(job.observed_at)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FailuresTable({ jobs, groups }: { jobs: FailedJob[]; groups: Group[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('jobs.col.job')}</th>
            <th>{t('jobs.col.clusterQos')}</th>
            <th>{t('jobs.col.result')}</th>
            <th>{t('jobs.col.exitCode')}</th>
            <th>{t('jobs.col.ended')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <strong className="truncate">{job.name}</strong>
                <span className="sub mono">
                  {job.id} · {job.user}
                </span>
              </td>
              <td>
                {groupLabel(groups, job.cluster_id)}
                <span className="sub">{job.qos || '—'}</span>
              </td>
              <td>
                <Status state={job.state} />
              </td>
              <td className="mono">{job.exit_code ?? '—'}</td>
              <td title={job.end ?? ''}>{dateTime(job.end)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `partial`: some samples count only part of the sources; their bars are hatched. */
export function ChartLegend({ partial = false }: { partial?: boolean }) {
  return (
    <span className="legend">
      <span>
        <i className="legend-line" />
        {t('chart.utilization')}
      </span>
      <span>
        <i className="legend-bar" />
        {t('chart.allocated')}
      </span>
      {partial && (
        <span>
          <i className="legend-bar partial" />
          {t('chart.partial')}
        </span>
      )}
    </span>
  );
}
