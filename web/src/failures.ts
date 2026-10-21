import { relativeTime } from './domain';
import { t } from './i18n';
import type { MessageKey } from './i18n';
import { jobTime } from './jobFacts';
import type { Job } from './types';

const REPORTED: Record<string, MessageKey> = {
  OUT_OF_MEMORY: 'failure.memory',
  TIMEOUT: 'failure.timeout',
  DEADLINE: 'failure.timeout',
  NODE_FAIL: 'failure.node',
  BOOT_FAIL: 'failure.node',
  PREEMPTED: 'failure.preempted',
};
const SCHEDULERS: Record<string, string> = {
  slurm: 'Slurm',
  pbs: 'PBS',
  lsf: 'LSF',
  kubernetes: 'Kubernetes',
};

/** Interpret only driver-normalized facts. A raw exit code is never a signal guess. */
export function failureExplanation(job: Job, driver: string) {
  const cause = REPORTED[job.state.toUpperCase()];
  if (cause)
    return {
      summary: t('failure.reported', {
        scheduler: SCHEDULERS[driver] ?? t('failure.scheduler'),
        cause: t(cause),
      }),
      evidence: null,
    };
  if (job.state.toUpperCase() !== 'FAILED') return null;
  if (job.exit_status != null && job.exit_status >= 1 && job.exit_status <= 125)
    return { summary: t('failure.program', { status: job.exit_status }), evidence: null };
  if (job.reason) return { summary: null, evidence: null };
  if (job.exit_signal === 9)
    return { summary: t('failure.sigkill'), evidence: t('failure.signalEvidence', { signal: 9 }) };
  if (job.exit_status === 127)
    return {
      summary: t('failure.command'),
      evidence: t('failure.statusEvidence', { status: 127 }),
    };
  if (driver === 'pbs' && /^-\d+$/.test(job.exit_code ?? ''))
    return { summary: t('failure.schedulerCode', { code: job.exit_code! }), evidence: null };
  return { summary: t('failure.rawCode', { code: job.exit_code ?? '—' }), evidence: null };
}

export function failureEnd(job: Job) {
  const value = job.ended_at || job.end;
  return value && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? relativeTime(value) : jobTime(value);
}

/** IDs come from driver rows, not display names. Quote every shell argument. */
export function inspectionCommand(job: Job, driver: string): string | null {
  const prefix = `${job.cluster_id}:`;
  if (!job.id.startsWith(prefix)) return null;
  const id = job.id.slice(prefix.length);
  if (!id || id.startsWith('-')) return null;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  switch (driver) {
    case 'slurm':
      return `sacct -j ${quote(id)} --format=JobID,State,ExitCode,Elapsed,Timelimit,ReqMem,MaxRSS,NodeList,WorkDir`;
    case 'pbs':
      return `qstat -fx ${quote(id)}`;
    case 'lsf':
      return `bhist -l ${quote(id)}`;
    case 'kubernetes': {
      const [namespace, name] = id.split('/');
      return namespace && name && !name.startsWith('-')
        ? `kubectl describe pod -n ${quote(namespace)} ${quote(name)}`
        : null;
    }
    default:
      return null;
  }
}
