import type { Dashboard, Source } from '../types';
import type { Group } from '../groups';
import { instanceGroupKey } from '../groups';
import { sourceHasData, summarize, summarizeNodes, uniqueJobs } from '../domain';
import { t } from '../i18n';
import { sourceState } from '../labels';
import { recentlyReachable } from './util';

/** Allocation, capacity and state of one cluster or platform. */
export function groupSummary(data: Dashboard, group: Group) {
  const ids = new Set(group.sources.map((source) => source.id));
  const instances = data.instances.filter(
    (item) => instanceGroupKey(item, data.sources) === group.key,
  );
  const jobs = uniqueJobs(data.jobs.filter((job) => job.cluster_id === group.key));
  const scoped = summarize({ ...data, sources: group.sources, jobs, instances });
  const nodes = summarizeNodes(data.nodes.filter((node) => node.cluster_id === group.key));
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
  const updated = [
    ...group.sources.map((source) => source.last_success),
    ...instances.map((item) => item.observed_at),
  ]
    .filter((at): at is string => !!at)
    .sort()
    .pop();
  return { ids, instances, scoped, nodes, state, updated };
}

/** A platform whose instance list could not be read has an unknown count, not zero. */
export function instanceCount(sources: Source[], count: number) {
  if (sources.every((source) => sourceHasData(source, 'instances')))
    return t('overview.instances', { count });
  return count ? t('overview.instancesAtLeast', { count }) : t('overview.instancesUnknown');
}
