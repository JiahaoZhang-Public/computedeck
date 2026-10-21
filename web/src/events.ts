import { statusLabel } from './labels';
import type { DeckEvent } from './types';
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

export type EventTone = 'green' | 'amber' | 'red' | 'gray';

/** One line describing an event, in the current language. */
export function eventText(event: DeckEvent): string {
  if (event.group) {
    const names = event.group.names.map(({ name, count }) => `${name} ×${count}`).join(', ');
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
    case 'job.started':
      return job?.node
        ? t('event.jobStartedOn', { job: name, node: job.node })
        : t('event.jobStarted', { job: name });
    case 'job.finished': {
      const outcome = t(OUTCOME_LABELS[event.data.outcome ?? 'unknown'] ?? 'event.outcome.unknown');
      const text = t('event.jobFinished', { job: name, outcome });
      return event.data.outcome === 'unknown'
        ? `${text} · ${t(event.data.outcome_reason === 'outcomes_unavailable' ? 'event.outcomesUnavailable' : 'event.outcomeNotReported')}`
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
    const tones = event.group.events.map(eventTone);
    return tones.includes('red') ? 'red' : tones.includes('green') ? 'green' : 'gray';
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

/** Hide old duplicate ending rows once this source uses reconciled endings. */
export function activityEvents(events: DeckEvent[]): DeckEvent[] {
  const sources = new Set(
    events.filter((event) => event.type === 'job.finished').map((event) => event.source_id),
  );
  return events
    .filter(
      (event) =>
        !(['job.failed', 'job.ended'].includes(event.type) && sources.has(event.source_id)),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function eventTimeTitle(event: DeckEvent): string {
  if (event.group) return eventTimeText(event) ?? dateTime(event.at);
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

function timeRange(start: string, end: string): string {
  return Date.parse(start) === Date.parse(end)
    ? eventClock(start)
    : t('event.between', { start: eventClock(start), end: eventClock(end) });
}

export function eventTimeText(event: DeckEvent): string | null {
  if (event.group) {
    const unknown = event.group.events.find((child) => !ownTime(child) && child.data.since);
    const text = unknown
      ? timeRange(unknown.data.since!, unknown.data.observed_at ?? unknown.at)
      : timeRange(event.group.first_at, event.group.last_at);
    return event.group.events.some((child) => !ownTime(child))
      ? `${text} · ${t(event.type === 'job.started' ? 'event.observedStartTime' : 'event.observedTime')}`
      : text;
  }
  const own = ownTime(event);
  if (own && event.type === 'job.finished') return t('event.endedAt', { time: eventClock(own) });
  if (!own && event.data.since)
    return timeRange(event.data.since, event.data.observed_at ?? event.at);
  return null;
}
