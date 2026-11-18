import type { Dashboard, NodeSummary, Source } from '../types';
import type { Group } from '../groups';
import { instanceGroupKey } from '../groups';
import { partialCount, sourceHasData } from '../domain';
import { t } from '../i18n';
import { sourceState } from '../labels';
import { recentlyReachable } from './util';

/** Allocation, capacity and state of one cluster or platform. */
export function groupSummary(data: Dashboard, group: Group) {
  const ids = new Set(group.sources.map((source) => source.id));
  const instances = data.instances.filter(
    (item) => instanceGroupKey(item, data.sources) === group.key,
  );
  const scoped = data.summary.groups[group.key];
  const nodes = scoped.nodes;
  const order = [
    'error',
    'stale',
    'unavailable',
    'degraded',
    'partial',
    'configured',
    'syncing',
    'ready',
    'disabled',
  ];
  const enabledSources = group.sources.filter((source) => source.enabled);
  const states = (enabledSources.length ? enabledSources : group.sources).map(sourceState);
  let state = order.find((item) => states.includes(item)) ?? states[0];
  if (!state)
    state = instances.length
      ? instances.some(recentlyReachable)
        ? 'reachable'
        : 'unverified'
      : 'unconfigured';
  const times = enabledSources.length
    ? enabledSources.map((source) => source.last_success)
    : instances.map((item) => item.observed_at).filter(Boolean);
  const updated =
    times.length && times.every(Boolean)
      ? (times as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      : undefined;
  return { ids, instances, scoped, nodes, state, updated };
}

/** A platform whose instance list could not be read has an unknown count, not zero. */
export function instanceCount(sources: Source[], count: number) {
  if (sources.every((source) => sourceHasData(source, 'instances')))
    return t('overview.instances', { count });
  return count ? t('overview.instancesAtLeast', { count }) : t('overview.instancesUnknown');
}

/** Allocation and usable capacity share wording and severity on cards and overview rows. */
/** "12 / 32": allocated of usable GPUs; the column header says what the numbers are. */
export function allocationText(nodes: NodeSummary) {
  return `${nodes.allocated ?? '—'} / ${partialCount(nodes.usable, nodes.known_usable)}`;
}
