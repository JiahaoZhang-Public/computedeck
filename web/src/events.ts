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
  const job = event.data.job;
  const name = job?.name || job?.id || '';
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
  const delay = event.data.observed_at
    ? Math.floor((Date.parse(event.data.observed_at) - Date.parse(event.at)) / 60000)
    : 0;
  const stamp = dateTime(event.at);
  if (
    (event.type === 'job.finished' && !event.data.ended_at) ||
    (event.type === 'job.started' && !event.data.started_at)
  )
    return `${stamp} · ${t('event.observedTime')}`;
  return delay > 0 ? `${stamp} · ${t('event.seenLater', { minutes: delay })}` : stamp;
}

export function eventTimeText(event: DeckEvent): string | null {
  if (event.type !== 'job.finished' || !event.data.ended_at) return null;
  const ended = new Date(event.at);
  const today = ended.toDateString() === new Date().toDateString();
  return t('event.endedAt', {
    time: today
      ? ended.toLocaleTimeString(locale(), { hour12: false, hour: '2-digit', minute: '2-digit' })
      : dateTime(event.at),
  });
}
