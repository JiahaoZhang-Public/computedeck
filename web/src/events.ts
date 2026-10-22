import { statusLabel } from './labels';
import type { DeckEvent, Job } from './types';
import { formatMessage, locale, t } from './i18n';
import type { MessageKey } from './i18n';
import { dateTime } from './domain';

export const OUTCOME_LABELS: Record<string, MessageKey> = {
  completed: 'event.outcome.completed',
  cancelled: 'event.outcome.cancelled',
  failed: 'event.outcome.failed',
  timeout: 'event.outcome.timeout',
  out_of_memory: 'event.outcome.out_of_memory',
  node_fail: 'event.outcome.node_fail',
  boot_fail: 'event.outcome.boot_fail',
  deadline: 'event.outcome.deadline',
  preempted: 'event.outcome.preempted',
  unknown: 'event.outcome.unknown',
};

const CHANGE_LABELS: Record<string, Record<string, MessageKey>> = {
  'change.source': {
    added: 'event.change.source.added',
    edited: 'event.change.source.edited',
    enabled: 'event.change.source.enabled',
    disabled: 'event.change.source.disabled',
    removed: 'event.change.source.removed',
  },
  'change.node': {
    added: 'event.change.node.added',
    edited: 'event.change.node.edited',
    removed: 'event.change.node.removed',
  },
  'change.instance': {
    added: 'event.change.instance.added',
    edited: 'event.change.instance.edited',
    removed: 'event.change.instance.removed',
  },
  'change.tool': {
    on: 'event.change.tool.on',
    off: 'event.change.tool.off',
    settings: 'event.change.tool.settings',
  },
  'change.import': { imported: 'event.change.import' },
};

const FIELD_LABELS: Record<string, MessageKey> = {
  name: 'source.form.name',
  cluster_id: 'source.form.cluster',
  interval_minutes: 'source.form.interval',
  enabled: 'source.form.enabled',
  node_id: 'source.form.node',
  ssh_alias: 'source.form.sshAliasLabel',
  username: 'job.user',
  host: 'instance.form.host',
  port: 'instance.form.port',
  platform: 'instance.form.platform',
  external_id: 'instance.form.externalId',
  gpu_count: 'instance.form.gpuCount',
  gpu_type: 'instance.form.gpuType',
  hourly_cost: 'instance.form.price',
  currency: 'instance.form.currency',
  options: 'event.change.options',
};

export function changeFieldLabel(field: string): string {
  return FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field;
}

export type EventTone = 'green' | 'amber' | 'red' | 'gray';

/** One line describing an event, in the current language. */
export function eventText(event: DeckEvent): string {
  if (event.type.startsWith('change.')) {
    const key = CHANGE_LABELS[event.type]?.[event.data.action ?? ''];
    return t(key ?? 'event.change.unknown', {
      name: event.data.name ?? event.data.subject_id ?? '',
      sources: event.data.counts?.sources ?? '—',
      nodes: event.data.counts?.nodes ?? '—',
      instances: event.data.counts?.instances ?? '—',
    });
  }
  if (event.group) {
    const names = event.group.names
      .map(({ name, count }) => `${name} ×${count}`)
      .join(t('common.listSeparator'));
    const labels: Record<string, MessageKey> = {
      'job.started': 'notify.event.started',
      'job.finished': 'notify.event.finished',
      'job.failed': 'notify.event.failed',
      'job.ended': 'notify.event.ended',
      'source.failed': 'notify.event.sourceFailed',
      'source.recovered': 'notify.event.sourceRecovered',
    };
    const text = t(names ? 'event.groupWithNames' : 'event.group', {
      count: event.group.count,
      type: labels[event.type] ? t(labels[event.type]) : event.type,
      names,
    });
    const outcomes = Object.entries(event.group.outcomes ?? {})
      .sort(
        ([a], [b]) =>
          Number(['completed', 'cancelled', 'unknown'].includes(a)) -
          Number(['completed', 'cancelled', 'unknown'].includes(b)),
      )
      .map(
        ([outcome, count]) => `${count} ${t(OUTCOME_LABELS[outcome] ?? 'event.outcome.unknown')}`,
      )
      .join(' · ');
    return outcomes ? `${text} · ${outcomes}` : text;
  }
  const job = event.data.job;
  const element = job?.array_id ? (job.id?.split(':').at(-1) ?? job.array_index) : null;
  const name = (job?.name || job?.id || '') + (job?.name && element ? ` [${element}]` : '');
  const source = event.data.source_name ?? event.source_id ?? '';
  switch (event.type) {
    case 'source.gap': {
      const checked = event.data.failures_checked_from;
      const unchecked =
        checked &&
        event.data.unobserved_from &&
        Date.parse(checked) > Date.parse(event.data.unobserved_from);
      return t(unchecked ? 'event.sourceGapUnchecked' : 'event.sourceGap', {
        source,
        from: dateTime(event.data.unobserved_from),
        to: dateTime(event.data.unobserved_to),
        time: dateTime(checked),
      });
    }
    case 'service.gap':
      return t('event.serviceGap', {
        from: dateTime(event.data.from),
        to: dateTime(event.data.to),
      });
    case 'job.started':
      return job?.node
        ? t('event.jobStartedOn', { job: name, node: job.node })
        : t('event.jobStarted', { job: name });
    case 'job.finished': {
      const outcome = t(OUTCOME_LABELS[event.data.outcome ?? 'unknown'] ?? 'event.outcome.unknown');
      const text = t('event.jobFinished', { job: name, outcome });
      return event.data.outcome === 'unknown'
        ? `${text} · ${t(event.data.outcome_reason === 'outcomes_unavailable' ? 'event.outcomesUnavailable' : event.data.outcome_reason === 'outside_lookback' ? 'event.outsideLookback' : 'event.outcomeNotReported')}`
        : text;
    }
    case 'job.ended':
      return t('event.jobEnded', { job: name });
    case 'job.failed':
      return t('event.jobFailed', {
        job: name,
        state: statusLabel(job?.state ?? ''),
        code: job?.exit_code ?? '—',
      });
    case 'source.failed':
      return t('event.sourceFailed', { source, error: formatMessage(event.data.error) });
    case 'source.recovered':
      return t('event.sourceRecovered', { source });
    default:
      return event.type;
  }
}

export function eventTone(event: DeckEvent): EventTone {
  if (event.group) {
    const tones =
      event.type === 'job.finished' && event.group.outcomes
        ? Object.keys(event.group.outcomes).map((outcome) =>
            eventTone({ ...event, group: undefined, data: { outcome } }),
          )
        : event.group.events.map(eventTone);
    return tones.includes('red')
      ? 'red'
      : tones.length > 0 && tones.every((tone) => tone === 'green')
        ? 'green'
        : 'gray';
  }
  if (event.type === 'job.finished') {
    if (event.data.outcome === 'completed') return 'green';
    if (event.data.outcome === 'cancelled' || event.data.outcome === 'unknown') return 'gray';
    return 'red';
  }
  if (event.type === 'job.failed' || event.type === 'source.failed') return 'red';
  if (event.type === 'job.started' || event.type === 'source.recovered') return 'green';
  return 'gray';
}

/** Retain pre-upgrade endings alongside new reconciled events. */
export function activityEvents(events: DeckEvent[]): DeckEvent[] {
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function eventTimeTitle(event: DeckEvent): string {
  if (event.group) return groupTime(event, dateTime);
  const delay = event.data.observed_at
    ? Math.floor((Date.parse(event.data.observed_at) - Date.parse(event.at)) / 60000)
    : 0;
  const stamp = dateTime(event.at);
  if (event.type === 'job.started' && !event.data.started_at)
    return `${stamp} · ${t('event.observedStartTime')}`;
  if (event.type === 'job.finished' && !event.data.ended_at)
    return `${stamp} · ${t('event.observedTime')}`;
  return delay > 0 ? `${stamp} · ${t('event.seenLater', { minutes: delay })}` : stamp;
}

function ownTime(event: DeckEvent): string | null {
  if (event.type === 'job.finished') return event.data.ended_at ?? null;
  if (event.type === 'job.started') return event.data.started_at ?? null;
  return event.at;
}

function eventClock(at: string): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(locale(), { hour12: false, hour: '2-digit', minute: '2-digit' })
    : dateTime(at);
}

function timeRange(start: string, end: string, format = eventClock): string {
  return Date.parse(start) === Date.parse(end)
    ? format(start)
    : t('event.between', { start: format(start), end: format(end) });
}

function groupTime(event: DeckEvent, format = eventClock): string {
  const group = event.group!;
  const unknown = group.events.find((child) => !ownTime(child) && child.data.since);
  const since = group.since ?? unknown?.data.since;
  const text = since
    ? timeRange(since, event.data.observed_at ?? unknown?.data.observed_at ?? event.at, format)
    : timeRange(group.first_at, group.last_at, format);
  const observed = group.observed_time ?? group.events.some((child) => !ownTime(child));
  return observed
    ? `${text} · ${t(event.type === 'job.started' ? 'event.observedStartTime' : 'event.observedTime')}`
    : text;
}

export function eventTimeText(event: DeckEvent): string | null {
  if (event.group) return groupTime(event);
  const own = ownTime(event);
  if (own && event.type === 'job.finished') return t('event.endedAt', { time: eventClock(own) });
  if (!own && event.data.since)
    return timeRange(event.data.since, event.data.observed_at ?? event.at);
  if (!own)
    return t('event.observedShort', { time: eventClock(event.data.observed_at ?? event.at) });
  return null;
}

/** An immutable event snapshot, with missing fields kept unknown. */
export function eventJob(event: DeckEvent): Job | null {
  const row = event.data.job;
  if (!row?.id || !['job.started', 'job.finished', 'job.failed', 'job.ended'].includes(event.type))
    return null;
  const job: Job = {
    source_id: event.source_id ?? '',
    cluster_id: event.data.cluster_id ?? '',
    name: row.id,
    user: event.data.username ?? '',
    account: '',
    partition: null,
    qos: null,
    state: 'unknown',
    gpu_count: null,
    gpu_type: null,
    cpu_count: null,
    node: null,
    elapsed: '',
    reason: null,
    gpu_utilization: null,
    cpu_utilization: null,
    memory_utilization: null,
    observed_at: null,
    ...row,
    id: row.id,
  };
  if (event.type === 'job.finished') {
    job.state =
      event.data.state ?? (event.data.outcome === 'unknown' ? 'unknown' : (row.state ?? 'unknown'));
    job.exit_code = event.data.exit_code === undefined ? row.exit_code : event.data.exit_code;
    job.ended_at = event.data.ended_at;
    if (event.data.outcome === 'unknown') {
      job.end = null;
      job.reason = null;
    }
  }
  if (event.type === 'job.ended') {
    job.state = 'unknown';
    job.end = null;
    job.ended_at = null;
  }
  return job;
}
