import { locale, t } from './i18n';
import type {
  ComputeNode,
  Dashboard,
  HistoryPoint,
  Instance,
  Job,
  QosLimit,
  Source,
} from './types';

export function uniqueJobs(jobs: Job[]): Job[] {
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
}
export function sourceHasData(source: Source, capability: string) {
  return (
    source.enabled &&
    !!source.last_success &&
    !source.stale &&
    !source.error &&
    ['ready', 'syncing'].includes(source.status) &&
    source.capabilities.includes(capability)
  );
}
/**
 * Slurm states in which a job holds its GPUs: starting on its nodes (CONFIGURING), running,
 * and finishing until the scheduler releases them (COMPLETING).
 */
const ALLOCATED_STATES = ['CONFIGURING', 'RUNNING', 'COMPLETING'];
export function holdsAllocation(job: Pick<Job, 'state'>) {
  return ALLOCATED_STATES.includes(job.state.toUpperCase());
}
/** Instance GPU allocation lifecycle; kept in parity with drivers/cloud.py. */
export const INSTANCE_LIFECYCLE = {
  running: 'held',
  reported_running: 'held',
  stopped: 'not_held',
  terminated: 'not_held',
  deleted: 'not_held',
  desired_stopped: 'not_held',
  desired_terminated: 'not_held',
  desired_running: 'unknown',
  unknown: 'unknown',
  missing: 'unknown',
} as const;

export function instanceLifecycle(state: string | null | undefined) {
  const key = state?.toLowerCase() ?? '';
  return Object.hasOwn(INSTANCE_LIFECYCLE, key)
    ? INSTANCE_LIFECYCLE[key as keyof typeof INSTANCE_LIFECYCLE]
    : 'unknown';
}
/** Enabled cluster logins without a current job list, as selected by the server. */
export function jobsMissing(data: Pick<Dashboard, 'summary' | 'sources'>) {
  const ids = new Set(data.summary.jobs.missing_source_ids);
  return data.sources.filter((source) => ids.has(source.id));
}

/** Current jobs followed by the last known jobs of enabled, unmeasured logins. */
export function listedJobs(data: Pick<Dashboard, 'summary' | 'jobs'>) {
  const ids = new Set(data.summary.jobs.listed_ids);
  const currentIds = new Set(data.summary.jobs.current_ids);
  const jobs = uniqueJobs(data.jobs.filter((job) => ids.has(job.id)));
  return {
    jobs: [
      ...sortJobs(jobs.filter((job) => currentIds.has(job.id))),
      ...sortJobs(jobs.filter((job) => !currentIds.has(job.id))),
    ],
    stale: new Set(data.summary.jobs.missing_source_ids),
  };
}

/** How many jobs there are: exact when no login in scope lacks a current job list. */
export function jobCount(current: number, missing: number) {
  return missing ? partialCount(null, current) : current;
}

/** Show a known subtotal as a lower bound when the complete total is unknown. */
export function partialCount(total: number | null, known: number | null) {
  return total ?? (known == null || known === 0 ? '—' : `≥ ${known}`);
}

export function jobGpuResources(job: Job) {
  const state = job.state.toUpperCase();
  return {
    requested: state === 'PENDING' ? job.gpu_count : null,
    allocated: holdsAllocation(job) ? job.gpu_count : state === 'PENDING' ? 0 : null,
  };
}
export function uniqueNodes(nodes: ComputeNode[]) {
  const result = new Map<string, ComputeNode>();
  for (const node of nodes) {
    const key = `${node.cluster_id}:${node.name}`;
    const previous = result.get(key);
    if (!previous || (node.observed_at ?? '') >= (previous.observed_at ?? ''))
      result.set(key, node);
  }
  return [...result.values()];
}
export function historyAllocation(point: HistoryPoint): number | null {
  return point.known_allocated_gpus !== undefined
    ? point.known_allocated_gpus
    : point.allocated_gpus;
}
/** A recorded allocation that leaves some sources out: a lower bound, not the total. */
export function historyPartial(point: HistoryPoint) {
  return (
    historyAllocation(point) != null &&
    (point.allocated_gpus == null || (point.unknown_allocation_sources ?? 0) > 0)
  );
}
/**
 * GPUs an instance holds: those with compute processes on a machine read over SSH, the
 * allocation a provider lists otherwise. A machine added by hand counts only what an SSH
 * check measured, never the GPUs typed in.
 */
export function instanceAllocation(instance: Instance): number | null {
  return instance.manual || instance.metrics_scope === 'host_visible'
    ? (instance.gpu_allocated ?? null)
    : instance.gpu_count;
}
export function percentage(value: number | null | undefined) {
  return value == null ? '—' : `${Math.round(value)}%`;
}
export function relativeTime(value: string | null | undefined) {
  if (!value) return t('time.never');
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return t('time.unknown');
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  if (minutes < 1440) return t('time.hoursAgo', { count: Math.floor(minutes / 60) });
  return t('time.daysAgo', { count: Math.floor(minutes / 1440) });
}
export function dateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale(), { hour12: false, dateStyle: 'short', timeStyle: 'short' });
}
/** The hourly price applies while an instance runs; a stopped or terminated one is not billed at it. */
export function runningPrice(item: Instance): number | null {
  const lifecycle = instanceLifecycle(item.state);
  if (lifecycle === 'held') return item.hourly_cost;
  if (lifecycle === 'not_held') return null;
  // Keep the existing price display for unknown/transitional states until cost accounting
  // defines them. A displayed price is not evidence that the instance holds GPUs.
  return /stopped|terminated|deleted|exited/i.test(item.state) ? null : item.hourly_cost;
}
export function money(value: number | null, currency: string) {
  if (value === null) return t('money.unknown');
  try {
    return new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
export function elapsedSeconds(value: string | null | undefined) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((value ?? '').trim());
  if (!match) return 0;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
export function sortJobs(jobs: Job[]): Job[] {
  const rank = (job: Job) =>
    holdsAllocation(job) ? 0 : job.state.toUpperCase() === 'PENDING' ? 1 : 2;
  return [...jobs].sort(
    (a, b) => rank(a) - rank(b) || elapsedSeconds(b.elapsed) - elapsedSeconds(a.elapsed),
  );
}
/** GPU entries in a Slurm TRES list; typed and total entries are distinct constraints. */
export function gpuTres(tres: string | null | undefined) {
  return (tres ?? '').split(',').flatMap((entry) => {
    const match = /^gres\/gpu(?::([^=]+))?=(\d+|N)$/.exec(entry.trim());
    return match
      ? [
          {
            model: (match[1] ?? '').toLowerCase(),
            value: match[2] === 'N' ? Infinity : Number(match[2]),
          },
        ]
      : [];
  });
}

/** A total limit, or the strictest total/model limit when a model is selected. */
export function qosGpuLimit(qos: QosLimit, model = ''): number | null {
  const tres = qos.limits?.MaxTRESPU;
  if (!tres) return null;
  const entries = gpuTres(tres);
  const applicable = entries.filter(
    (entry) => !entry.model || (model && entry.model === model.toLowerCase()),
  );
  if (applicable.length) return Math.min(...applicable.map((entry) => entry.value));
  // A typed-only limit does not establish a total limit for an unspecified model.
  if (!model && entries.some((entry) => entry.model)) return null;
  return /(?:^|,)\s*gres\/gpu(?::[^=,]+)?=/.test(tres) && !entries.length ? null : Infinity;
}

/**
 * This login's use against MaxTRESPU, when the scheduler reports it: Slurm under `usage`,
 * a Kubernetes quota as `UsedTRESPU` among its limits.
 */
export function qosUsedTres(qos: QosLimit): string | null {
  return qos.usage?.MaxTRESPU ?? qos.limits?.UsedTRESPU ?? null;
}

/** GPUs counted against the total limit, when reported by the scheduler. */
export function qosGpuUsed(qos: QosLimit): number | null {
  return gpuTres(qosUsedTres(qos)).find((entry) => !entry.model)?.value ?? null;
}
