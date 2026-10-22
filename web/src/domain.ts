import { locale, t } from './i18n';
import type {
  ComputeNode,
  Dashboard,
  HistoryPoint,
  GpuRow,
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
export const RUNNING_STATES = ['CONFIGURING', 'RUNNING', 'COMPLETING', 'R', 'CF', 'CG'];
export const PENDING_STATES = ['PENDING', 'PD', 'Q', 'PEND', 'QUEUED'];
export function holdsAllocation(job: Pick<Job, 'state'>) {
  return RUNNING_STATES.includes(job.state.toUpperCase());
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
  const pending = PENDING_STATES.includes(job.state.toUpperCase());
  return {
    requested: pending ? job.gpu_count : null,
    allocated: holdsAllocation(job) ? job.gpu_count : pending ? 0 : null,
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
 * GPUs an instance holds: those with processes or significant memory use over SSH, the
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
  return instanceLifecycle(item.state) === 'held' ? item.hourly_cost : null;
}
export function runningSince(item: Instance) {
  if (instanceLifecycle(item.state) !== 'held') return null;
  for (const [origin, at] of [
    ['provider', item.started_at],
    ['observed', item.seen_running_since],
  ] as const) {
    if (at && Number.isFinite(Date.parse(at))) return { at, origin };
  }
  return null;
}
/** Freeze estimates at the last listing when collection is no longer current. */
export function runningHours(item: Instance, source?: Source, now = Date.now()) {
  const since = runningSince(item);
  if (!since) return null;
  const current = source ? sourceHasData(source, 'instances') : false;
  const asOf = current ? null : (source?.last_success ?? null);
  const end = current ? now : asOf ? Date.parse(asOf) : NaN;
  const hours = (Math.min(end, now) - Date.parse(since.at)) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? { ...since, hours, asOf } : null;
}
export function costThisRun(item: Instance, source?: Source, now = Date.now()) {
  const run = runningHours(item, source, now);
  const price = runningPrice(item);
  return run && price != null && item.currency ? price * run.hours : null;
}
/** Compact elapsed time, rounded down: minutes below an hour, otherwise days and hours. */
export function runDuration(hours: number) {
  const minutes = Math.floor(hours * 60);
  if (minutes < 60) return t('cost.duration.minutes', { count: minutes });
  const days = Math.floor(minutes / 1440);
  const remainingHours = Math.floor(minutes / 60) % 24;
  return [
    days ? t('cost.duration.days', { count: days }) : '',
    remainingHours ? t('cost.duration.hours', { count: remainingHours }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
export function money(value: number | null, currency: string, lowerBound = false) {
  if (value === null) return t('money.unknown');
  if (lowerBound) value += 1e-9 * Math.max(1, Math.abs(value));
  try {
    return new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      roundingMode: lowerBound ? 'floor' : 'halfExpand',
    }).format(value);
  } catch {
    const amount = new Intl.NumberFormat(locale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
      roundingMode: lowerBound ? 'floor' : 'halfExpand',
    }).format(value);
    return `${currency} ${amount}`;
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

export type JobArray = {
  id: string;
  name: string;
  cluster_id: string;
  array_id: string;
  jobs: Job[];
  running: number;
  pending: number;
  other: number;
  heldGpus: number | string;
  unknownGpus: number;
  qos: string | null;
  qosMixed: boolean;
  partition: string | null;
  partitionMixed: boolean;
  pendingReasons: Job[];
};

export function arrayLabel(id: string): string {
  return id.endsWith('[]') ? id : `[${id}]`;
}

/** A shared array fact; unknown values are distinct from differing values. */
export function arrayField(jobs: Job[], field: 'user' | 'qos' | 'partition') {
  const value = jobs[0]?.[field] ?? null;
  const mixed = jobs.some((job) => (job[field] ?? null) !== value);
  return { value: mixed ? null : value, mixed };
}

/** Group the already filtered, ordered list; the first element determines each group's rank. */
export function groupArrays(jobs: Job[]): (Job | JobArray)[] {
  const arrays = new Map<string, Job[]>();
  for (const job of jobs) {
    if (!job.array_id) continue;
    const key = `${job.cluster_id}:${job.array_id}`;
    const elements = arrays.get(key) ?? [];
    elements.push(job);
    arrays.set(key, elements);
  }
  const shown = new Set<string>();
  return jobs.flatMap((job): (Job | JobArray)[] => {
    const key = `${job.cluster_id}:${job.array_id}`;
    const elements = job.array_id ? arrays.get(key)! : [];
    if (elements.length < 2) return [job];
    if (shown.has(key)) return [];
    shown.add(key);
    const held = elements.filter(holdsAllocation);
    const pending = elements.filter((item) => PENDING_STATES.includes(item.state.toUpperCase()));
    const known = held.reduce((sum, item) => sum + (item.gpu_count ?? 0), 0);
    const unknown = held.filter((item) => item.gpu_count == null).length;
    const reasons = new Map<string, Job[]>();
    for (const item of pending) {
      if (item.reason == null) continue;
      const same = reasons.get(item.reason) ?? [];
      same.push(item);
      reasons.set(item.reason, same);
    }
    const qos = arrayField(elements, 'qos');
    const partition = arrayField(elements, 'partition');
    return [
      {
        id: key,
        name: job.name,
        cluster_id: job.cluster_id,
        array_id: job.array_id!,
        jobs: elements,
        running: held.length,
        pending: pending.length,
        other: elements.length - held.length - pending.length,
        heldGpus: partialCount(unknown ? null : known, known),
        unknownGpus: unknown,
        qos: qos.value,
        qosMixed: qos.mixed,
        partition: partition.value,
        partitionMixed: partition.mixed,
        pendingReasons: [...reasons.values()]
          .sort((a, b) => b.length - a.length)
          .map((items) => items[0]),
      },
    ];
  });
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

export function gpuMatchesModel(gpu: GpuRow, model: string) {
  return !model || gpu.name?.toLowerCase() === model.toLowerCase();
}

/** Only the driver's explicit free state is evidence; unknown never becomes free. */
export function freeGpuIndexes(instance: Instance, model: string) {
  return (instance.gpus ?? [])
    .filter((gpu) => gpu.in_use === false && gpuMatchesModel(gpu, model))
    .flatMap((gpu) => (gpu.index == null ? [] : [gpu.index]));
}
