import { dateTime, PENDING_STATES } from './domain';
import { t } from './i18n';
import type { MessageKey } from './i18n';
import type { Job } from './types';

const SLURM_REASONS: Record<string, string> = {
  Priority: 'priority',
  Resources: 'resources',
  Dependency: 'dependency',
  DependencyNeverSatisfied: 'dependencyFailed',
  BeginTime: 'begin',
  JobHeldUser: 'hold',
  JobHeldAdmin: 'hold',
  JobArrayTaskLimit: 'array',
  QOSMaxGRESPerUser: 'personalLimit',
  QOSMaxCpuPerUserLimit: 'personalLimit',
  QOSMaxJobsPerUserLimit: 'personalLimit',
  QOSMaxSubmitJobPerUserLimit: 'personalLimit',
  AssocMaxJobsLimit: 'personalLimit',
  AssocMaxSubmitJobLimit: 'personalLimit',
  QOSMaxGRESPerJob: 'requestLimit',
  QOSMaxWallDurationPerJobLimit: 'requestLimit',
  QOSGrpGRES: 'groupLimit',
  QOSGrpCpuLimit: 'groupLimit',
  AssocGrpGRES: 'groupLimit',
  PartitionDown: 'partition',
  ReqNodeNotAvail: 'nodes',
  InvalidAccount: 'access',
  InvalidQOS: 'access',
};
const FAILURE_REASONS: Record<string, string> = {
  OUT_OF_MEMORY: 'memory',
  TIMEOUT: 'timeout',
  DEADLINE: 'timeout',
  NODE_FAIL: 'nodeFailure',
  BOOT_FAIL: 'nodeFailure',
  PREEMPTED: 'preempted',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export function reasonCode(reason: string | null | undefined) {
  return (reason ?? '').split(/[ ,:(]/)[0];
}

export function reasonKind(code: string, driver: string) {
  return (driver === 'slurm' ? SLURM_REASONS[code] : undefined) ?? 'unknown';
}

export function jobReason(job: Pick<Job, 'state' | 'reason'>, driver: string) {
  const state = job.state.toUpperCase();
  const kind = PENDING_STATES.includes(state)
    ? reasonKind(reasonCode(job.reason), driver)
    : FAILURE_REASONS[state];
  if (!kind) return null;
  return {
    kind,
    summary: t(`job.explain.${kind}` as MessageKey),
    next: t(`job.next.${kind}` as MessageKey),
  };
}

function instant(value: string | null | undefined) {
  if (!value || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function jobTime(value: string | null | undefined) {
  if (!value) return '—';
  return instant(value) == null ? t('job.schedulerTime', { time: value }) : dateTime(value);
}

/** Rough distance to Slurm's expected start, rounded down. A past estimate stays in the past. */
export function relativeStart(value: string, now = Date.now()): string | null {
  const at = instant(value);
  if (at == null) return null;
  const ahead = at >= now;
  const span = Math.floor(Math.abs(at - now) / 60000);
  if (span < 1) return t(ahead ? 'job.startEstimate.soon' : 'job.startEstimate.justPassed');
  if (span < 60)
    return t(ahead ? 'job.startEstimate.inMinutes' : 'job.startEstimate.minutesAgo', {
      count: span,
    });
  if (span < 1440)
    return t(ahead ? 'job.startEstimate.inHours' : 'job.startEstimate.hoursAgo', {
      count: Math.floor(span / 60),
    });
  return t(ahead ? 'job.startEstimate.inDays' : 'job.startEstimate.daysAgo', {
    count: Math.floor(span / 1440),
  });
}

/** Slurm's pending start estimate for the waiting-job drawer. Missing means not collected. */
export function startEstimateLabel(
  job: Pick<Job, 'expected_start_at' | 'queue_unknown'>,
  now = Date.now(),
): string {
  if (job.expected_start_at === undefined) return t('job.startEstimate.notCollected');
  if (job.queue_unknown === 'private_data') return t('job.startEstimate.private');
  if (!job.expected_start_at) return t('job.startEstimate.unknown');
  const relative = relativeStart(job.expected_start_at, now);
  return t(relative ? 'job.startEstimate' : 'job.startEstimate.absolute', {
    time: jobTime(job.expected_start_at),
    relative,
  });
}

/** Bound a pending wait by the last observation, rather than extending stale data to now. */
export function jobWaiting(job: Job) {
  const start = instant(job.submitted_at);
  const end = instant(
    PENDING_STATES.includes(job.state.toUpperCase()) ? job.observed_at : job.started_at,
  );
  if (start == null || end == null || end < start) return '—';
  const minutes = Math.floor((end - start) / 60000);
  return t('job.waitDuration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
