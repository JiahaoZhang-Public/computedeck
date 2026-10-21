import { useCallback, useEffect, useRef, useState } from 'react';
import { useVisibleInterval } from '../useVisibleInterval';
import type { DeckEvent } from '../types';
import { api } from '../api';
import { t } from '../i18n';
import { relativeTime } from '../domain';
import { activityEvents, eventText, eventTone, eventTimeTitle, eventTimeText } from '../events';
import { Panel } from '../ui';

/** What changed between collections: jobs that started, ended or failed, sources that broke. */
export function ActivityPanel({
  demo,
  limit = 12,
  token,
}: {
  demo: boolean;
  limit?: number;
  token?: string;
}) {
  const [events, setEvents] = useState<DeckEvent[] | null>(null);
  const loadId = useRef(0);
  const load = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const rows = await api<DeckEvent[]>(`/events?limit=${limit}&demo=${demo}`);
      if (id === loadId.current) setEvents(activityEvents(rows));
    } catch {
      if (id === loadId.current) setEvents((current) => current ?? []);
    }
  }, [demo, limit]);
  useEffect(
    () => () => {
      loadId.current += 1;
    },
    [load],
  );
  useVisibleInterval(load, 15000, token);
  return (
    <Panel title={t('activity.title')} count={events?.length}>
      {events?.length ? (
        <ul className="activity">
          {events.map((event) => (
            <li key={event.id}>
              <span className={`dot ${eventTone(event)}`} />
              <span className="grow">
                {eventText(event)}
                <small>
                  {[event.data.source_name, event.data.username].filter(Boolean).join(' · ')}
                </small>
              </span>
              <time dateTime={event.at} title={eventTimeTitle(event)}>
                {eventTimeText(event) ?? relativeTime(event.at)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-note">{events ? t('activity.empty') : t('chart.loading')}</p>
      )}
    </Panel>
  );
}
