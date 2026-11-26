import { dateTime, relativeTime } from './domain';
import { formatMessage, hasKey, localized, t } from './i18n';
import { sourceState } from './labels';
import type { Attention, CollectionNode, Dashboard, Health, Tool } from './types';

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
      const collector = id === 'collector' || id.startsWith('collector:');
      if (!collector && !health?.plugins?.[id.split(':')[0]]?.enabled) continue;
      faults.push({
        id,
        title: t(collector ? 'health.collectorFault' : 'health.pluginFault'),
        detail: `${id}: ${fault.error}`,
        at: fault.at,
        page: collector ? undefined : 'toolbox',
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
        detail: `${unreadable.map(([table, count]) => `${inventoryLabel(table)}: ${count}`).join(', ')}. ${t('health.serviceLog')}`,
      });
    for (const node of nodes.filter((node) => node.status === 'error'))
      faults.push({
        id: `node:${node.id}`,
        title: t('health.nodeFault', { name: node.name }),
        detail: formatMessage(node.error),
        page: 'sources',
      });
  }
  // Beyond service faults, the pill follows the Needs attention list: dismissing the last item
  // calms it. Service faults are never dismissible and always show.
  const active = (data?.attention ?? []).filter((item) => !item.muted);
  const count = data?.attention_count ?? active.length;
  let level: import('./ui/shapes').StatusKind = 'unknown';
  let label = t('health.unknown');
  let quiet = false;
  if (needsToken) {
    // Signed out: the service state is unknown.
  } else if (error) {
    level = 'error';
    label = t('health.unreachable');
  } else if (faults.length) {
    level = 'error';
    label = faults[0].title;
  } else if (count > 0) {
    level = active.some((item) => item.severity === 'error') ? 'error' : 'warn';
    label = t('health.attention', { count });
  } else if (data && !enabled.length) {
    label = t('health.noSourcesConnected');
  } else if (!demo && health?.polling === false) {
    level = 'off';
    label = t('health.pollingOff');
  } else {
    // Nothing needs attention: only the freshness, in a neutral colour.
    quiet = true;
    label = age;
  }
  return {
    level,
    label,
    count: faults.length || error || needsToken ? 0 : count,
    quiet,
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

/** Allow the scheduler's tick and normal collection time before calling an attempt overdue. */
export function collectionOverdue(at: string | null | undefined, collecting = false) {
  return !collecting && !!at && Date.parse(at) < Date.now() - 2 * 60_000;
}

export function nextAttemptText(at: string | null | undefined, collecting = false) {
  return t(collectionOverdue(at, collecting) ? 'health.overdue' : 'health.nextAttempt', {
    time: dateTime(at),
  });
}

export function inventoryLabel(table: string) {
  const key = `health.inventory.${table}`;
  return hasKey(key) ? t(key) : t('health.inventory.other');
}

export function attentionText(item: Attention, tools: Pick<Tool, 'id' | 'name'>[]) {
  let name = item.subject.name;
  if (item.kind === 'unreadable_rows') name = inventoryLabel(item.subject.id);
  else if (item.subject.kind === 'plugin' || item.subject.kind === 'service') {
    const id = item.subject.id;
    if (id === 'collector' || id.startsWith('collector:')) {
      if (!id.startsWith('collector:commit:')) name = t('health.collector');
    } else {
      const tool = tools.find((tool) => tool.id === id.split(':')[0]);
      name = tool ? localized(tool.name) : t('health.plugin');
    }
  }
  // Titles name what and its state; the error code and cause are in the item's detail.
  const message = { ...item.message, name };
  return formatMessage(message);
}
