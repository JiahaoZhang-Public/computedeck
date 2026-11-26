import { useClock } from '../ui/clock';
import { useRouteParam } from '../useRouteParam';
import { ClockText } from '../data/ClockText';
import type { ToastAction } from '../layers/Toasts';
import type { ReactNode, RefObject } from 'react';
import { History, Search, X } from 'lucide-react';
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
import { hasLayer } from '../layers/stack';
import { t } from '../i18n';
import type { PluginProps, WebPlugin } from '../plugins';
import {
  arrayField,
  arrayLabel,
  costThisRun,
  dateTime,
  jobGpuResources,
  money,
  PENDING_STATES,
  relativeTime,
  runDuration,
  runningHours,
} from '../domain';
import type { JobArray } from '../domain';
import { failureEnd } from '../failures';
import { jobElapsed, jobReason, jobTime, jobWaiting } from '../jobFacts';
import { Empty, Status } from '../ui';
import { UnmeasuredLinks } from './UnmeasuredLinks';

export type Ctx = {
  actions: CtxActions;
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
  /** Dismiss until it changes, snooze, or restore; local to the page in example mode. */
  muteAttention: (
    item: Attention,
    action: 'acknowledge' | 'snooze' | 'clear',
    until?: '1h' | 'tomorrow',
  ) => Promise<void>;
  diagnose: (source: Source) => void;
  health: Health | null;
  locale: Locale;
  pendingLocale?: Locale | null;
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
  collectSource: Ctx['collect'];
  testSource: (
    source: Source,
  ) => Promise<import('../ConnectionChecks').Diagnostic[] | undefined | void>;
  pauseSource: (source: Source) => Promise<void>;
  sourceInFlight: Readonly<Record<string, 'test' | 'collect'>>;
  addInstance: () => void;
  showSSH: () => void;
  openJob: (job: Job) => void;
  openEvent: (event: DeckEvent) => void;
  openArray: (array: JobArray) => void;
  openInstance: (item: Instance) => void;
  copy: import('../copy').Copy;
  notify: (text: string, tone?: 'ok' | 'error', action?: ToastAction) => void;
  backup: () => Promise<void>;
  toggleDemo: () => void;
};

export type CtxActions = Pick<
  Ctx,
  | 'setGroup'
  | 'setQuery'
  | 'openAttention'
  | 'muteAttention'
  | 'diagnose'
  | 'changeLocale'
  | 'navigate'
  | 'reload'
  | 'updateTool'
  | 'configure'
  | 'collect'
  | 'collectSource'
  | 'testSource'
  | 'pauseSource'
  | 'addInstance'
  | 'showSSH'
  | 'openJob'
  | 'openEvent'
  | 'openArray'
  | 'openInstance'
  | 'copy'
  | 'notify'
  | 'backup'
  | 'toggleDemo'
>;

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
        onKeyDown={(event) => {
          // Escape empties the field, unless a pane or dialog is open: that closes first and
          // the search stays as it is.
          if (event.key === 'Escape' && query && !hasLayer()) {
            event.stopPropagation();
            setQuery('');
          }
        }}
        // One word in the field; what it searches is its name and tooltip.
        placeholder={t('search.placeholder')}
        aria-label={placeholder}
        title={placeholder}
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

/** A real filter, not a view: one small chip in the toolbar ("All clusters", then each one). */
export function GroupFilter({
  ctx,
  options,
  allLabel,
}: {
  ctx: Ctx;
  options: Group[];
  allLabel: string;
}) {
  if (options.length < 2) return null;
  return (
    <select
      className="chip"
      aria-label={t('filter.byGroup')}
      value={ctx.group}
      onChange={(event) => ctx.setGroup(event.target.value)}
    >
      <option value="all">{allLabel}</option>
      {options.map((item) => (
        <option key={item.key} value={item.key}>
          {item.label}
        </option>
      ))}
    </select>
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
          {t('overview.manageSources')}
        </a>
      }
    />
  );
}

/** The one exception a row may carry: its jobs are the last ones collected, not current. */
export function StaleMark({ at }: { at: string | null | undefined }) {
  return (
    <span className="stale-mark" title={t('cloud.staleSince', { time: relativeTime(at) })}>
      <History size={13} aria-hidden="true" />
      <span className="sr-only">
        <ClockText>{() => t('cloud.staleSince', { time: relativeTime(at) })}</ClockText>
      </span>
    </span>
  );
}

/** "8 × H100": count and model in one cell; a queued job's requested count is muted. */
function GpuCell({
  count,
  type,
  requested,
}: {
  count: ReactNode;
  type?: string | null;
  requested?: boolean;
}) {
  const text = type ? (
    <>
      {count} × {type}
    </>
  ) : (
    count
  );
  return requested ? <span className="requested">{text}</span> : <>{text}</>;
}

/** Beside a job list that is partly unknown: one mark that names whose jobs are missing. */
export function JobsMissingNote({
  ctx,
  missing,
  staleRows,
  staleCount = 0,
  value,
}: {
  ctx: Ctx;
  missing: Source[];
  staleRows: boolean;
  staleCount?: number;
  /** The partial count that opens the list ("≥ 36"). */
  value?: string | number;
}) {
  const ids = new Set(missing.map((source) => source.id));
  const items = ctx.data.summary.queued_unmeasured.filter((item) => ids.has(item.subject.id));
  return (
    <UnmeasuredLinks
      ctx={ctx}
      value={value}
      items={
        items.length
          ? items
          : missing.map((source) => ({
              subject: { kind: 'source' as const, id: source.id, name: source.name },
              reason: { code: 'summary_source_stale' },
            }))
      }
      label={t('jobs.missing.count', { count: missing.length })}
      note={
        (staleRows || staleCount > 0) &&
        [
          staleRows && t('jobs.missing.stale'),
          staleCount > 0 && t('jobs.lastKnownCount', { count: staleCount }),
        ]
          .filter(Boolean)
          .join(' ')
      }
    />
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
  // The open drawer's row is marked, so the list shows which job the panel describes.
  const [openJob] = useRouteParam('job');
  if (!jobs.length) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table
        data-detail-list
        className={`table ${compact ? 'array-elements-table' : 'jobs-table'} stack-on-phone meta-on-phone`}
      >
        <thead>
          <tr>
            <th>{t(compact ? 'jobs.array.element' : 'jobs.col.job')}</th>
            {!compact && <th className="panel-hide col-mid">{t('job.user')}</th>}
            {!compact && <th className="panel-hide col-high">{t('job.cluster')}</th>}
            {!compact && (
              <th className="panel-hide col-low" title={t('jobs.col.clusterQosHint')}>
                {t('job.queue')}
              </th>
            )}
            <th className="num">GPU</th>
            <th>{t('jobs.col.state')}</th>
            <th>{t('jobs.col.nodeReason')}</th>
            <th className="num panel-hide">{t('jobs.col.timing')}</th>
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
            // The same queued states the job pane and GPU counts recognise (PD, Q, QUEUED …).
            const pending = PENDING_STATES.includes(job.state.toUpperCase());
            const old = !!stale?.has(job.source_id);
            const driver =
              groups.flatMap((group) => group.sources).find((source) => source.id === job.source_id)
                ?.driver ?? '';
            const explanation = pending ? jobReason(job, driver) : null;
            return (
              <tr
                key={job.id}
                data-detail-key="job"
                data-detail-id={job.id}
                className={['clickable', old && 'stale-row', job.id === openJob && 'selected']
                  .filter(Boolean)
                  .join(' ')}
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
                </td>
                {!compact && (
                  <>
                    <td className="panel-hide col-mid" data-label={t('job.user')}>
                      {job.user || '—'}
                    </td>
                    <td className="panel-hide col-high" data-label={t('job.cluster')}>
                      {groupLabel(groups, job.cluster_id)}
                    </td>
                    <td className="panel-hide col-low" data-label={t('job.queue')}>
                      {job.qos || '—'}
                    </td>
                  </>
                )}
                <td className="num" data-label="GPU">
                  <GpuCell
                    count={(pending ? gpu.requested : gpu.allocated) ?? '—'}
                    type={compact ? null : job.gpu_type}
                    requested={pending}
                  />
                </td>
                <td data-label={t('jobs.col.state')}>
                  <Status state={job.state} />
                  {old && <StaleMark at={job.observed_at} />}
                </td>
                <td
                  className={pending ? 'fill reason' : 'fill'}
                  data-label={t('jobs.col.nodeReason')}
                >
                  {/* What, not why: a short reason label; the sentence is in the job's pane. */}
                  <span className="clamp">
                    {pending ? (explanation?.label ?? t('job.short.waiting')) : job.node || '—'}
                  </span>
                </td>
                <td className="num panel-hide" data-label={t('jobs.col.timing')}>
                  {pending ? jobWaiting(job) : jobElapsed(job.elapsed)}
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
  const [openArray] = useRouteParam('array');
  const old = array.jobs.some((job) => stale?.has(job.source_id));
  const observed = array.jobs.some((job) => !job.observed_at)
    ? null
    : array.jobs.map((job) => job.observed_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const reason = array.pendingReasons[0];
  const user = arrayField(array.jobs, 'user');
  const types = [...new Set(array.jobs.map((job) => job.gpu_type || ''))];
  const gpuType = types.length === 1 ? types[0] : null;
  const unknownGpus =
    array.unknownGpus > 0 ? t('jobs.array.unknownGpus', { count: array.unknownGpus }) : undefined;
  const driver =
    groups.flatMap((group) => group.sources).find((source) => source.id === reason?.source_id)
      ?.driver ?? '';
  return (
    <tr
      className={['clickable array-row', old && 'stale-row', array.id === openArray && 'selected']
        .filter(Boolean)
        .join(' ')}
      data-detail-key="array"
      data-detail-id={array.id}
      tabIndex={0}
      onClick={() => onOpen?.(array)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen?.(array);
      }}
    >
      <td>
        <strong className="truncate" title={`${array.name} ${arrayLabel(array.array_id)}`}>
          {array.name}
        </strong>
      </td>
      <td className="panel-hide col-mid" data-label={t('job.user')}>
        {user.mixed ? t('jobs.array.mixed') : user.value || '—'}
      </td>
      <td className="panel-hide col-high" data-label={t('job.cluster')}>
        {groupLabel(groups, array.cluster_id)}
      </td>
      <td className="panel-hide col-low" data-label={t('job.queue')}>
        {array.qosMixed ? t('jobs.array.mixed') : array.qos || '—'}
      </td>
      <td className="num" data-label="GPU">
        <span title={unknownGpus}>
          <GpuCell count={array.heldGpus} type={gpuType} />
        </span>
        {unknownGpus && <span className="sr-only">, {unknownGpus}</span>}
      </td>
      <td data-label={t('jobs.col.state')}>
        {/* One short summary; the per-state counts are in the array's pane. */}
        <span className="array-states">
          {array.running > 0
            ? t('jobs.array.summary', { count: array.jobs.length, running: array.running })
            : array.pending > 0
              ? t('jobs.array.summaryQueued', { count: array.jobs.length, pending: array.pending })
              : t('jobs.array.total', { count: array.jobs.length })}
        </span>
        {old && <StaleMark at={observed} />}
      </td>
      <td
        className={reason || array.pending ? 'fill reason' : 'fill'}
        data-label={t('jobs.col.nodeReason')}
      >
        <span className="clamp">
          {reason
            ? (jobReason(reason, driver)?.label ?? t('job.short.waiting'))
            : array.pending
              ? t('job.short.waiting')
              : '—'}
        </span>
      </td>
      <td className="num panel-hide phone-hide" data-label={t('jobs.col.timing')}>
        —
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
      <table data-detail-list className="table stack-on-phone meta-on-phone">
        <thead>
          <tr>
            <th>{t('jobs.col.job')}</th>
            <th className="col-mid">{t('job.user')}</th>
            <th className="col-high">{t('job.cluster')}</th>
            <th className="col-low" title={t('jobs.col.clusterQosHint')}>
              {t('job.queue')}
            </th>
            <th>{t('jobs.col.result')}</th>
            <th>{t('jobs.col.exitCode')}</th>
            <th>{t('jobs.col.ended')}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              data-detail-key={onOpen ? 'failure' : undefined}
              data-detail-id={job.id}
              className={onOpen ? 'clickable' : undefined}
              tabIndex={onOpen ? 0 : undefined}
              onClick={() => onOpen?.(job)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onOpen?.(job);
              }}
            >
              <td>
                <strong className="truncate" title={job.name}>
                  {job.name}
                </strong>
              </td>
              <td className="col-mid" data-label={t('job.user')}>
                {job.user || '—'}
              </td>
              <td className="col-high" data-label={t('job.cluster')}>
                {groupLabel(groups, job.cluster_id)}
              </td>
              <td className="col-low" data-label={t('job.queue')}>
                {job.qos || '—'}
              </td>
              <td data-label={t('jobs.col.result')}>
                <Status state={job.state} />
              </td>
              <td className="mono" data-label={t('jobs.col.exitCode')}>
                {job.exit_code ?? '—'}
              </td>
              <td title={jobTime(job.ended_at || job.end)} data-label={t('jobs.col.ended')}>
                <ClockText>{() => failureEnd(job)}</ClockText>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The full estimate and its qualifications in the instance drawer. */
export function InstanceRunCost({ item, source }: { item: Instance; source?: Source }) {
  useClock();
  const run = runningHours(item, source);
  const cost = costThisRun(item, source);
  if (!run) return <>—</>;
  return (
    <>
      <span className="sub">
        {t(run.origin === 'provider' ? 'cost.runningFor' : 'cost.observedFor', {
          duration: runDuration(run.hours),
        })}
      </span>
      <span className="sub">
        {cost == null ? '—' : t('cost.estimate', { cost: money(cost, item.currency) })}
      </span>
      {run.asOf && <span className="sub">{t('cost.asOf', { time: dateTime(run.asOf) })}</span>}
      {cost != null && <span className="sub">{t('cost.excludes')}</span>}
    </>
  );
}

/** Scheduler-managed hosts remain inspectable, but are counted with their cluster. */
export function MachineNodeNote({ item }: { item: Instance }) {
  return item.same_node ? (
    <span className="sub">
      {t('instance.sameNode', { node: item.same_node.name, cluster: item.same_node.cluster_name })}
    </span>
  ) : null;
}
