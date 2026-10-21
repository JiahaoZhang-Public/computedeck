import { useCallback, useEffect, useRef, useState } from 'react';
import { useVisibleInterval } from '../useVisibleInterval';
import type { DeckEvent, Source, Tool } from '../types';
import { api } from '../api';
import { localized, t } from '../i18n';
import { relativeTime } from '../domain';
import {
  activityEvents,
  eventJob,
  eventText,
  eventTone,
  eventTimeTitle,
  eventTimeText,
} from '../events';
import { Panel } from '../ui';
import { routeHash } from '../routes';

/** What changed between collections: jobs that started, ended or failed, sources that broke. */
export function ActivityPanel({
  demo,
  limit = 12,
  token,
  onOpen,
  sources = [],
  tools = [],
}: {
  sources?: Source[];
  tools?: Tool[];
  demo: boolean;
  limit?: number;
  token?: string;
  onOpen?: (event: DeckEvent) => void;
}) {
  const [events, setEvents] = useState<DeckEvent[] | null>(null);
  const loadId = useRef(0);
  const load = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const rows = await api<DeckEvent[]>(
        `/events?limit=${limit}&demo=${demo}&group=1&include=changes`,
      );
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
            <ActivityRow
              key={event.id}
              event={event}
              onOpen={onOpen}
              sources={sources}
              tools={tools}
            />
          ))}
        </ul>
      ) : (
        <p className="panel-note">{events ? t('activity.empty') : t('chart.loading')}</p>
      )}
    </Panel>
  );
}

function ActivityRow({
  event,
  onOpen,
  sources,
  tools,
}: {
  event: DeckEvent;
  onOpen?: (event: DeckEvent) => void;
  sources: Source[];
  tools: Tool[];
}) {
  const tool =
    event.type === 'change.tool'
      ? tools.find((tool) => tool.id === event.data.subject_id)
      : undefined;
  const source =
    event.type === 'change.source' && event.data.action !== 'removed'
      ? sources.find((source) => source.id === event.data.subject_id)
      : undefined;
  const sourceLine = [event.data.source_name, event.data.username].filter(Boolean).join(' · ');
  const fields = ['change.source', 'change.node', 'change.instance'].includes(event.type)
    ? (event.data.fields ?? []).filter(
        (field) =>
          event.data.action === 'edited' ||
          (['enabled', 'disabled'].includes(event.data.action ?? '') && field !== 'enabled'),
      )
    : [];
  const content = (
    <>
      <span className={`dot ${eventTone(event)}`} />
      <span className="grow">
        {eventText(
          tool ? { ...event, data: { ...event.data, name: localized(tool.name) } } : event,
        )}
        {sourceLine && <small>{sourceLine}</small>}
        {fields.length > 0 && (
          <small>
            {t('event.change.fields', { fields: fields.join(t('common.listSeparator')) })}
          </small>
        )}
      </span>
      <time dateTime={event.at} title={eventTimeTitle(event)}>
        {eventTimeText(event) ?? relativeTime(event.at)}
      </time>
    </>
  );
  if (!event.group)
    return (
      <li>
        {onOpen && eventJob(event) ? (
          <button className="activity-job" onClick={() => onOpen(event)}>
            {content}
          </button>
        ) : source ? (
          <a className="activity-job" href={routeHash('sources', source.cluster_id)}>
            {content}
          </a>
        ) : (
          content
        )}
      </li>
    );
  return (
    <li className="activity-group">
      <details>
        <summary>{content}</summary>
        <ul className="activity">
          {event.group.events.map((child) => (
            <ActivityRow
              key={child.id}
              event={child}
              onOpen={onOpen}
              sources={sources}
              tools={tools}
            />
          ))}
          {event.group.count > event.group.events.length && (
            <li>{t('event.more', { count: event.group.count - event.group.events.length })}</li>
          )}
        </ul>
      </details>
    </li>
  );
}
