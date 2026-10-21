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
  AssocMaxJobsLimit: 'personalLimit',
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

export function jobReason(job: Pick<Job, 'state' | 'reason'>, driver: string) {
  const state = job.state.toUpperCase();
  const code = (job.reason ?? '').split(/[ ,:(]/)[0];
  const kind = PENDING_STATES.includes(state)
    ? ((driver === 'slurm' ? SLURM_REASONS[code] : undefined) ?? 'unknown')
    : FAILURE_REASONS[state];
  if (!kind) return null;
  return {
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
