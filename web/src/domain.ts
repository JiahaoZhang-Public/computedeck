import { locale, t } from './i18n';
import { nodeAbnormal } from './labels';
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
export function knownSum(values: (number | null | undefined)[]): number | null {
  if (values.some((value) => value == null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
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
/** Current jobs exclude retained snapshots from disabled or failed collectors. */
export function currentJobs(data: Pick<Dashboard, 'sources' | 'jobs'>) {
  const ids = new Set(
    data.sources.filter((source) => sourceHasData(source, 'jobs')).map((source) => source.id),
  );
  return uniqueJobs(data.jobs.filter((job) => ids.has(job.source_id)));
}

/** Enabled cluster logins without a current job list: failed, stale or not collected yet. */
export function jobsMissing(sources: Source[]) {
  return sources.filter(
    (source) => source.enabled && source.kind === 'cluster' && !sourceHasData(source, 'jobs'),
  );
}

/**
 * Jobs to list: the current ones, then the last-known jobs of enabled logins whose job list
 * is not current, the logins `stale` names. Jobs of disabled logins are left out.
 */
export function listedJobs(data: Pick<Dashboard, 'sources' | 'jobs'>) {
  const stale = new Set(jobsMissing(data.sources).map((source) => source.id));
  const current = sortJobs(currentJobs(data));
  const seen = new Set(current.map((job) => job.id));
  // A job a current login still sees is listed once, as current.
  const old = sortJobs(
    uniqueJobs(data.jobs.filter((job) => stale.has(job.source_id) && !seen.has(job.id))),
  );
  return { jobs: [...current, ...old], stale };
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
export function summarizeNodes(nodes: ComputeNode[]) {
  const unique = uniqueNodes(nodes);
  const capacity = unique.length ? knownSum(unique.map((node) => node.gpu_count)) : null;
  const allocated = unique.length ? knownSum(unique.map((node) => node.gpu_allocated)) : null;
  const unallocated = unique.length
    ? knownSum(
        unique.map((node) =>
          node.gpu_count == null ||
          node.gpu_allocated == null ||
          node.gpu_allocated > node.gpu_count
            ? null
            : node.gpu_count - node.gpu_allocated,
        ),
      )
    : null;
  const abnormal = unique.filter((node) => nodeAbnormal(node.state)).length;
  return {
    nodes: unique.length,
    capacity,
    allocated,
    unallocated,
    abnormal,
    unknown: unique.filter((node) => node.gpu_count == null || node.gpu_allocated == null).length,
    observedAt:
      unique
        .map((node) => node.observed_at)
        .filter((at): at is string => !!at)
        .sort()[0] ?? null,
    ratio:
      capacity !== null && allocated !== null && unallocated !== null
        ? capacity
          ? (allocated / capacity) * 100
          : 0
        : null,
  };
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
/**
 * When SSH last measured an instance: the reading of a machine read over SSH, or the last
 * check of an instance a provider lists, whose listing time measures nothing on it.
 */
export function sshSampledAt(instance: Instance): string | null {
  return instance.manual || instance.metrics_scope === 'host_visible'
    ? instance.observed_at
    : (instance.last_probe_attempt ?? null);
}

export function summarize(data: Dashboard) {
  const enabled = (sourceId: string) =>
    !data.sources.some((source) => source.id === sourceId && !source.enabled);
  const jobs = uniqueJobs(data.jobs.filter((job) => enabled(job.source_id)));
  const running = jobs.filter(holdsAllocation);
  const pending = jobs.filter((job) => job.state.toUpperCase() === 'PENDING');
  const instances = [
    ...new Map(
      data.instances
        .filter((item) => item.manual || enabled(item.source_id))
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const activeInstances = instances.filter((item) => instanceLifecycle(item.state) === 'held');
  const unconfigured =
    !data.sources.some((source) => source.enabled && source.last_success) &&
    !jobs.length &&
    !instances.length;
  // Every configured source is collected automatically; manual instances are not sources.
  const automaticSources = data.sources.filter((source) => source.enabled);
  const unknownSources = new Set(
    automaticSources
      .filter((source) => !sourceHasData(source, source.kind === 'cluster' ? 'jobs' : 'instances'))
      .map((source) => source.id),
  );
  const clusterSources = data.sources.filter(
    (source) => source.enabled && source.kind === 'cluster',
  );
  const jobsUnavailable =
    !clusterSources.length || clusterSources.some((source) => !sourceHasData(source, 'jobs'));
  const allocatedInstance = (item: Instance) => ({ ...item, gpu_count: instanceAllocation(item) });
  const allocations = [...running, ...activeInstances.map(allocatedInstance)];
  const sourceFresh = (sourceId: string, capability: string) => {
    const source = data.sources.find((item) => item.id === sourceId);
    return !!source && sourceHasData(source, capability);
  };
  const freshRunning = running.filter((job) => sourceFresh(job.source_id, 'jobs'));
  const freshPending = pending.filter((job) => sourceFresh(job.source_id, 'jobs'));
  // The service reports a machine added by hand as running only while a recent check
  // reached it; it has no source to be fresh.
  const instanceFresh = (item: Instance) =>
    !!item.manual || sourceFresh(item.source_id, 'instances');
  const freshInstances = activeInstances.filter(instanceFresh);
  for (const job of running)
    if (!sourceFresh(job.source_id, 'jobs')) unknownSources.add(job.source_id);
  for (const item of activeInstances) if (!instanceFresh(item)) unknownSources.add(item.source_id);
  for (const item of allocations) if (item.gpu_count == null) unknownSources.add(item.source_id);
  for (const item of instances)
    if (instanceLifecycle(item.state) === 'unknown') unknownSources.add(item.source_id);
  const knownAllocations = [...freshRunning, ...freshInstances.map(allocatedInstance)].filter(
    (item) => item.gpu_count != null,
  );
  const hasFreshSources = automaticSources.some((source) =>
    sourceHasData(source, source.kind === 'cluster' ? 'jobs' : 'instances'),
  );
  const knownAllocated =
    hasFreshSources || knownAllocations.length
      ? knownAllocations.reduce((sum, item) => sum + (item.gpu_count ?? 0), 0)
      : null;
  const sampled = [
    ...freshRunning,
    ...instances.filter((item) => {
      const sampledAt = sshSampledAt(item);
      return (
        data.mode === 'demo' ||
        (item.ssh_status === 'reachable' &&
          !!sampledAt &&
          Date.now() - new Date(sampledAt).getTime() < 720000)
      );
    }),
  ];
  const observedCount = (item: (typeof sampled)[number]) =>
    'gpu_observed_count' in item ? (item.gpu_observed_count ?? 0) : (item.gpu_count ?? 0);
  const observed = sampled.filter(
    (item) => item.gpu_utilization !== null && observedCount(item) > 0,
  );
  const covered = observed.reduce((sum, item) => sum + observedCount(item), 0);
  const utilization = covered
    ? observed.reduce((sum, item) => sum + (item.gpu_utilization ?? 0) * observedCount(item), 0) /
      covered
    : null;
  return {
    allocated:
      unconfigured || unknownSources.size > 0
        ? null
        : knownSum(allocations.map((item) => item.gpu_count)),
    knownAllocated,
    unknownAllocationSources: unknownSources.size,
    knownRequested:
      clusterSources.some((source) => sourceHasData(source, 'jobs')) &&
      (!freshPending.length || freshPending.some((job) => job.gpu_count != null))
        ? freshPending.reduce((sum, item) => sum + (item.gpu_count ?? 0), 0)
        : null,
    knownRunning: freshRunning.length,
    running: jobsUnavailable ? null : running.length,
    pending: jobsUnavailable ? null : pending.length,
    requested: jobsUnavailable ? null : knownSum(pending.map((item) => item.gpu_count)),
    utilization,
    covered,
    cpuUtilization: mean(sampled.map((item) => item.cpu_utilization)),
    memoryUtilization: mean(sampled.map((item) => item.memory_utilization)),
  };
}
export function mean(values: (number | null)[]): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : null;
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
