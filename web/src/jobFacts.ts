import { dateTime, elapsedSeconds, PENDING_STATES } from './domain';
import { duration } from './format';
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
  // An unknown reason is labelled by the scheduler's own short code, never the sentence.
  const code = reasonCode(job.reason);
  return {
    kind,
    label:
      kind === 'unknown' ? code || t('job.short.waiting') : t(`job.short.${kind}` as MessageKey),
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
  return duration(Math.floor((end - start) / 60000) * 60);
}

/** A scheduler's "1-06:12:04" as "1 d 6 h": every duration on a page reads the same way. */
export function jobElapsed(value: string | null | undefined) {
  if (!value) return '—';
  return /^(?:\d+-)?(?:\d+:)?\d+:\d+$/.test(value.trim()) ? duration(elapsedSeconds(value)) : value;
}
