import { hasKey, t } from './i18n';
import type { MessageKey } from './i18n';
import type { ComputeNode, Source } from './types';

const NEUTRAL = {
  account: 'job.account',
  partition: 'job.partition',
  qos: 'job.qos',
} as const;

const JOB_TERMS: Record<
  string,
  { account: MessageKey; partition: MessageKey; qos: MessageKey | null }
> = {
  slurm: NEUTRAL,
  pbs: { account: 'job.account', partition: 'job.queue', qos: null },
  lsf: { account: 'job.project', partition: 'job.queue', qos: null },
  kubernetes: {
    account: 'job.namespace',
    partition: 'job.nodePool',
    qos: 'job.priorityClass',
  },
};

export function jobTerms(driver: string) {
  return Object.hasOwn(JOB_TERMS, driver) ? JOB_TERMS[driver] : NEUTRAL;
}

export function statusLabel(state: string) {
  const key = `status.${state}`;
  return hasKey(key) ? t(key) : state;
}
export type Tone = 'green' | 'amber' | 'red' | 'gray';
export function statusTone(state: string): Tone {
  if (['RUNNING', 'running', 'reported_running', 'ready', 'reachable', 'COMPLETED'].includes(state))
    return 'green';
  if (
    [
      'PENDING',
      'CONFIGURING',
      'syncing',
      'desired_running',
      'COMPLETING',
      'stale',
      'partial',
      'degraded',
    ].includes(state)
  )
    return 'amber';
  if (
    [
      'error',
      'unavailable',
      'FAILED',
      'TIMEOUT',
      'OUT_OF_MEMORY',
      'NODE_FAIL',
      'BOOT_FAIL',
      'PREEMPTED',
    ].includes(state)
  )
    return 'red';
  return 'gray';
}
/** Availability is classified on the server, including reservations and power saving. */
export function nodeAbnormal(node: Pick<ComputeNode, 'health'>) {
  return node.health === 'unavailable';
}
export function nodeTone(node: Pick<ComputeNode, 'health' | 'state'>): Tone {
  if (nodeAbnormal(node)) return 'red';
  if (node.health === 'usable' && /idle/i.test(node.state)) return 'green';
  return 'gray';
}

export function sourceState(source: Source) {
  // A disabled login is never "stale", whatever an older version left in its status.
  if (!source.enabled)
    return source.status === 'unconfigured' && !source.last_success ? 'unconfigured' : 'disabled';
  if (source.stale) return 'stale';
  if (source.status === 'ready' && !source.last_success) return 'configured';
  if (
    ['ready', 'syncing'].includes(source.status) &&
    ['unavailable', 'degraded'].includes(source.cluster_state ?? '')
  )
    return source.cluster_state!;
  return source.status;
}
export function connectedSource(source: Source) {
  return (
    source.enabled &&
    ['ready', 'syncing'].includes(source.status) &&
    !!source.last_success &&
    !source.stale
  );
}
