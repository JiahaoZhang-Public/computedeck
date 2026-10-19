import { groupsOf, sourceLabel } from './groups';
import { relativeTime } from './domain';
import { formatMessage, t } from './i18n';
import { sourceState } from './labels';
import type { CollectionNode, Dashboard, Health } from './types';

export function computeHealth(
  data: Dashboard | null,
  health: Health | null,
  error: string | null,
  needsToken: boolean,
  demo: boolean,
  nodes: CollectionNode[] = [],
) {
  const sources = data?.sources ?? [];
  const enabled = sources.filter((source) => source.enabled);
  const age = data?.as_of
    ? relativeTime(data.as_of)
    : enabled.some((source) => !source.last_success)
      ? t('health.notCollected')
      : data && !enabled.length
        ? t('health.noSourcesConnected')
        : t('health.unknown');
  const faults: {
    id: string;
    title: string;
    detail: string;
    at?: string;
    page?: 'sources' | 'toolbox';
  }[] = [];
  if (!demo && !needsToken) {
    for (const [id, fault] of Object.entries(health?.background_errors ?? {})) {
      faults.push({
        id,
        title: t(
          id === 'collector' || id.startsWith('collector:')
            ? 'health.collectorFault'
            : 'health.pluginFault',
        ),
        detail: `${id}: ${fault.error}`,
        at: fault.at,
        page: id === 'collector' || id.startsWith('collector:') ? undefined : 'toolbox',
      });
    }
    const unreadable = Object.entries(health?.unreadable_rows ?? {}).filter(
      ([, count]) => count > 0,
    );
    if (unreadable.length)
      faults.push({
        id: 'unreadable',
        title: t('health.unreadable', {
          count: unreadable.reduce((sum, [, count]) => sum + count, 0),
        }),
        detail: `${unreadable.map(([table, count]) => `${table}: ${count}`).join(', ')}. ${t('health.serviceLog')}`,
      });
    for (const node of nodes.filter((node) => node.status === 'error'))
      faults.push({
        id: `node:${node.id}`,
        title: t('health.nodeFault', { name: node.name }),
        detail: formatMessage(node.error),
        page: 'sources',
      });
  }
  const failing = enabled.filter((source) => source.error || source.status === 'error');
  const stale = enabled.filter((source) => source.stale);
  let level: 'ok' | 'warn' | 'bad' | 'unknown' = 'unknown';
  let label = t('health.unknown');
  if (needsToken) label = t('health.unknown');
  else if (error) {
    level = 'bad';
    label = t('health.unreachable');
  } else if (demo) label = t('health.example');
  else if (faults.length) {
    level = 'bad';
    label = faults[0].title;
  } else if (failing.length) {
    level = 'bad';
    label =
      failing.length === 1
        ? t('health.sourceFailing', { name: sourceLabel(groupsOf(data!), failing[0]) })
        : t('health.failing', { count: failing.length });
  } else if (stale.length) {
    level = 'warn';
    label =
      stale.length === 1
        ? t('health.sourceStale', { name: sourceLabel(groupsOf(data!), stale[0]) })
        : t('health.stale', { count: stale.length });
  } else if (data && !enabled.length) {
    label = t('health.noSourcesConnected');
  } else if (health?.polling === false) {
    level = 'warn';
    label = t('health.pollingOff');
  } else if (enabled.some((source) => !source.last_success)) {
    level = 'warn';
    label = t('health.notCollected');
  } else if (data?.behind?.length) {
    level = 'warn';
    label = t('health.behind', { count: data.behind.length });
  } else if (data?.as_of && enabled.length && health && data.behind) {
    level = 'ok';
    label = t('health.fresh', { count: enabled.length });
  }
  return {
    level,
    label,
    age: needsToken ? t('health.unknown') : age,
    faults,
    collectorFault: faults.some(
      (fault) => fault.id === 'collector' || fault.id.startsWith('collector:'),
    ),
    rows: needsToken
      ? []
      : sources.map((source) => ({
          source,
          state: sourceState(source),
          collecting: data?.collecting?.includes(source.id) || source.status === 'syncing',
        })),
  };
}
