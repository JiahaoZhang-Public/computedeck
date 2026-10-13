import { useEffect, useState } from 'react';
import type { DeckEvent } from '../types';
import { api } from '../api';
import { t } from '../i18n';
import { relativeTime } from '../domain';
import { eventText, eventTone } from '../events';
import { Panel } from '../ui';

/** What changed between collections: jobs that started, ended or failed, sources that broke. */
export function ActivityPanel({ demo, limit = 12 }: { demo: boolean; limit?: number }) {
  const [events, setEvents] = useState<DeckEvent[] | null>(null);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<DeckEvent[]>(`/events?limit=${limit}&demo=${demo}`)
        .then((rows) => {
          if (active) setEvents(rows);
        })
        .catch(() => {
          if (active) setEvents((current) => current ?? []);
        });
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [demo, limit]);
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
              <time dateTime={event.at}>{relativeTime(event.at)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-note">{events ? t('activity.empty') : t('chart.loading')}</p>
      )}
    </Panel>
  );
}
