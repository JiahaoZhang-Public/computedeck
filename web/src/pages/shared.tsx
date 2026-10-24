import type { ReactNode, RefObject } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import type {
  Attention,
  CollectionNode,
  Dashboard,
  DeckEvent,
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
import { arrayLabel, jobGpuResources, relativeTime } from '../domain';
import type { JobArray } from '../domain';
import { failureEnd } from '../failures';
import { jobReason, jobTime, jobWaiting } from '../jobFacts';
import { Chips, Empty, Status } from '../ui';

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
  openAttention: (item: Attention) => void;
  diagnose: (source: Source) => void;
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
  openEvent: (event: DeckEvent) => void;
  openArray: (array: JobArray) => void;
  openInstance: (item: Instance) => void;
  copy: (text: string) => Promise<void>;
  notify: (text: string, tone?: 'ok' | 'error') => void;
  backup: () => Promise<void>;
  toggleDemo: () => void;
};

export function SearchBox({
  ctx,
  placeholder,
  maxLength,
}: {
  ctx: Ctx;
  placeholder: string;
  maxLength?: number;
}) {
  const { searchRef, query, setQuery } = ctx;
  return (
    <label className="search">
      <Search size={14} />
      <input
        ref={searchRef}
        maxLength={maxLength}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {query ? (
        <button className="icon-button" aria-label={t('search.clear')} onClick={() => setQuery('')}>
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
  staleCount = 0,
}: {
  groups: Group[];
  missing: Source[];
  staleRows: boolean;
  staleCount?: number;
}) {
  return (
    <p className="panel-note">
      {t('jobs.missing.text', { sources: sourceList(groups, missing) })}
      {staleRows && ` ${t('jobs.missing.stale')}`}
      {staleCount > 0 && (
        <span className="sub">{t('jobs.lastKnownCount', { count: staleCount })}</span>
      )}
    </p>
  );
}

export function JobsTable({
  jobs,
  groups,
  onOpen,
  onOpenArray,
  compact = false,
  empty,
  stale,
}: {
  jobs: (Job | JobArray)[];
  groups: Group[];
  onOpen: (job: Job) => void;
  onOpenArray?: (array: JobArray) => void;
  /** Array elements omit shared facts and use their index as the card title. */
  compact?: boolean;
  empty: ReactNode;
  /** Logins whose job list is not current; their rows are last-known jobs, tagged as such. */
  stale?: Set<string>;
}) {
  if (!jobs.length) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className={`table ${compact ? 'array-elements-table' : 'jobs-table'} stack-on-phone`}>
        <thead>
          <tr>
            <th>{t(compact ? 'jobs.array.element' : 'jobs.col.job')}</th>
            {!compact && <th title={t('jobs.col.clusterQosHint')}>{t('jobs.col.clusterQos')}</th>}
            {compact && <th>{t('jobs.col.state')}</th>}
            <th className="num">GPU</th>
            {!compact && <th className="num">CPU</th>}
            {!compact && <th>{t('jobs.col.state')}</th>}
            <th>{t('jobs.col.nodeReason')}</th>
            <th className="num">{t('jobs.col.timing')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            if ('jobs' in job)
              return (
                <ArrayRow
                  key={job.id}
                  array={job}
                  groups={groups}
                  stale={stale}
                  onOpen={onOpenArray}
                />
              );
            const gpu = jobGpuResources(job);
            const pending = job.state.toUpperCase() === 'PENDING';
            const old = !!stale?.has(job.source_id);
            const driver =
              groups.flatMap((group) => group.sources).find((source) => source.id === job.source_id)
                ?.driver ?? '';
            const explanation = pending ? jobReason(job, driver) : null;
            const stateCell = (
              <td data-label={t('jobs.col.state')}>
                <Status state={job.state} />
              </td>
            );
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
                  <strong
                    className={compact ? 'mono' : 'truncate'}
                    title={compact ? undefined : job.name}
                  >
                    {compact ? (job.array_index ?? '—') : job.name}
                  </strong>
                  <span className="sub mono">
                    {job.id}
                    {!compact && ` · ${job.user}`}
                  </span>
                  {old && (
                    <span className="sub">
                      <span className="tag amber">
                        {t('cloud.staleSince', { time: relativeTime(job.observed_at) })}
                      </span>
                    </span>
                  )}
                </td>
                {!compact && (
                  <td data-label={t('jobs.col.clusterQos')}>
                    {groupLabel(groups, job.cluster_id)}
                    <span className="sub">{job.qos || '—'}</span>
                  </td>
                )}
                {compact && stateCell}
                <td className="num" data-label={'GPU'}>
                  {pending ? (
                    <span className="muted">
                      {t('jobs.requested', { count: gpu.requested ?? '?' })}
                    </span>
                  ) : (
                    (gpu.allocated ?? '—')
                  )}
                  {!compact && <span className="sub">{job.gpu_type || ''}</span>}
                </td>
                {!compact && (
                  <td className="num" data-label={'CPU'}>
                    {job.cpu_count ?? '—'}
                  </td>
                )}
                {!compact && stateCell}
                <td data-label={t('jobs.col.nodeReason')}>
                  <span className="clamp" title={(pending ? job.reason : job.node) ?? ''}>
                    {pending
                      ? explanation?.summary || job.reason || t('jobs.waiting')
                      : job.node || '—'}
                  </span>
                  {!compact && pending && job.reason && <code className="sub">{job.reason}</code>}
                </td>
                <td className="num mono" data-label={t('jobs.col.timing')}>
                  {pending ? jobWaiting(job) : job.elapsed || '—'}
                  {!compact && (
                    <span className="sub" title={job.observed_at ?? ''}>
                      {relativeTime(job.observed_at)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ArrayRow({
  array,
  groups,
  stale,
  onOpen,
}: {
  array: JobArray;
  groups: Group[];
  stale?: Set<string>;
  onOpen?: (array: JobArray) => void;
}) {
  const old = array.jobs.some((job) => stale?.has(job.source_id));
  const observed = array.jobs.some((job) => !job.observed_at)
    ? null
    : array.jobs.map((job) => job.observed_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const reason = array.pendingReasons[0];
  const driver =
    groups.flatMap((group) => group.sources).find((source) => source.id === reason?.source_id)
      ?.driver ?? '';
  return (
    <tr
      className={`clickable array-row ${old ? 'stale-row' : ''}`}
      tabIndex={0}
      onClick={() => onOpen?.(array)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen?.(array);
      }}
    >
      <td>
        <strong className="truncate" title={array.name}>
          {array.name}
        </strong>
        <span className="sub mono">
          {arrayLabel(array.array_id)} · {t('jobs.array.count', { count: array.jobs.length })}
        </span>
        <span className="sub">{t('jobs.array.open')}</span>
        {old && (
          <span className="sub">
            <span className="tag amber">
              {t('cloud.staleSince', { time: relativeTime(observed) })}
            </span>
          </span>
        )}
      </td>
      <td data-label={t('jobs.col.clusterQos')}>
        {groupLabel(groups, array.cluster_id)}
        <span className="sub">{array.qosMixed ? t('jobs.array.mixed') : array.qos || '—'}</span>
        {(array.partitionMixed || array.qosMixed || array.partition !== array.qos) && (
          <span className="sub">
            {t('jobs.array.partition', {
              name: array.partitionMixed ? t('jobs.array.mixed') : array.partition || '—',
            })}
          </span>
        )}
      </td>
      <td className="num" data-label="GPU">
        {array.heldGpus}
        <span className="sub">{t('jobs.array.held')}</span>
        {array.unknownGpus > 0 && (
          <span className="sub">{t('jobs.array.unknownGpus', { count: array.unknownGpus })}</span>
        )}
      </td>
      <td className="num" data-label="CPU">
        —
      </td>
      <td data-label={t('jobs.col.state')}>
        <span className="tags array-states">
          {array.running > 0 && (
            <span className="tag">{t('jobs.array.running', { count: array.running })}</span>
          )}
          {array.pending > 0 && (
            <span className="tag">{t('jobs.array.pending', { count: array.pending })}</span>
          )}
          {array.other > 0 && (
            <span className="tag">{t('jobs.array.other', { count: array.other })}</span>
          )}
        </span>
      </td>
      <td data-label={t('jobs.col.nodeReason')}>
        <span className="clamp">
          {reason ? jobReason(reason, driver)?.summary || reason.reason || t('jobs.waiting') : '—'}
        </span>
        {reason?.reason && <code className="sub">{reason.reason}</code>}
        {array.pendingReasons.length > 1 && (
          <span className="sub">
            {t('jobs.array.otherReasons', { count: array.pendingReasons.length - 1 })}
          </span>
        )}
      </td>
      <td className="num" data-label={t('jobs.col.timing')}>
        —
        <span className="sub" title={observed ?? ''}>
          {relativeTime(observed)}
        </span>
      </td>
    </tr>
  );
}

export function FailuresTable({
  jobs,
  groups,
  onOpen,
}: {
  jobs: FailedJob[];
  groups: Group[];
  onOpen?: (job: Job) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="table stack-on-phone">
        <thead>
          <tr>
            <th>{t('jobs.col.job')}</th>
            <th title={t('jobs.col.clusterQosHint')}>{t('jobs.col.clusterQos')}</th>
            <th>{t('jobs.col.result')}</th>
            <th>{t('jobs.col.exitCode')}</th>
            <th>{t('jobs.col.ended')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              className={onOpen ? 'clickable' : undefined}
              tabIndex={onOpen ? 0 : undefined}
              onClick={() => onOpen?.(job)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onOpen?.(job);
              }}
            >
              <td>
                <strong className="truncate">{job.name}</strong>
                <span className="sub mono">
                  {job.id} · {job.user}
                </span>
              </td>
              <td data-label={t('jobs.col.clusterQos')}>
                {groupLabel(groups, job.cluster_id)}
                <span className="sub">{job.qos || '—'}</span>
              </td>
              <td data-label={t('jobs.col.result')}>
                <Status state={job.state} />
                {job.elapsed && (
                  <span className="sub">{t('failure.ran', { elapsed: job.elapsed })}</span>
                )}
              </td>
              <td className="mono" data-label={t('jobs.col.exitCode')}>
                {job.exit_code ?? '—'}
              </td>
              <td title={jobTime(job.ended_at || job.end)} data-label={t('jobs.col.ended')}>
                {failureEnd(job)}
              </td>
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
