import type { DeckEvent } from './types';
import { formatMessage, t } from './i18n';

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
    case 'job.ended':
      return t('event.jobEnded', { job: name });
    case 'job.failed':
      return t('event.jobFailed', {
        job: name,
        state: job?.state ?? '',
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
  if (event.type === 'job.failed' || event.type === 'source.failed') return 'red';
  if (event.type === 'job.started' || event.type === 'source.recovered') return 'green';
  return 'gray';
}
