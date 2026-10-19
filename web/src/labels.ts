import { hasKey, t } from './i18n';
import type { Source } from './types';

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
/**
 * Slurm power saving (POWER_DOWN, POWERING_DOWN, POWERED_DOWN, POWER_UP, POWERING_UP) is a
 * normal state of an idle node, not an outage; a node that is also down says so separately.
 */
const POWER_SAVING = /power(?:ed|ing)?_(?:down|up)/gi;
const ABNORMAL =
  /down|drain|fail|maint|not_resp|not_ready|cordon|offline|unavail|unreach|unknown|inval|reserved|\*/i;
/** A node that cannot take work now: down, draining, failing, INVAL (bad configuration), … */
export function nodeAbnormal(state: string) {
  return ABNORMAL.test(state.replace(POWER_SAVING, ''));
}
export function nodeTone(state: string): Tone {
  if (nodeAbnormal(state)) return 'red';
  if (/idle/i.test(state)) return 'green';
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

/** Missing optional capabilities are informational; failures and outages need attention. */
export function sourceAttentionTone(source: Source): 'red' | 'amber' | 'gray' {
  if (source.error || source.cluster_state === 'unavailable') return 'red';
  if (source.stale || source.cluster_state === 'degraded') return 'amber';
  return 'gray';
}
