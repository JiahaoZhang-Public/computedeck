import { useCallback, useEffect, useRef, useState } from 'react';
import { useVisibleInterval } from '../useVisibleInterval';
import type { DeckEvent, Source, Tool } from '../types';
import { api } from '../api';
import { formatMessage, locale, localized, t } from '../i18n';
import { dateTime, relativeTime } from '../domain';
import {
  activityEvents,
  eventJob,
  eventText,
  eventTone,
  eventTimeTitle,
  eventTimeText,
} from '../events';
import { Chips, Panel } from '../ui';
import { routeHash } from '../routes';
import { setRouteParams, useRouteParam } from '../useRouteParam';
import type { Ctx } from './shared';
import { SearchBox } from './shared';
import { statusLabel } from '../labels';
import { jobTime } from '../jobFacts';
import type { MessageKey } from '../i18n';

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
  const [error, setError] = useState(false);
  const loadId = useRef(0);
  const load = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const rows = await api<DeckEvent[]>(
        `/events?limit=${limit}&demo=${demo}&group=1&include=changes`,
      );
      if (id === loadId.current) {
        setEvents(activityEvents(rows));
        setError(false);
      }
    } catch {
      if (id === loadId.current) setError(true);
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
    <Panel
      title={t('activity.title')}
      count={events?.length}
      actions={
        <a className="link" href={routeHash('activity')}>
          {t('activity.all')}
        </a>
      }
    >
      {error && <ActivityError retry={load} />}
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
      ) : events || !error ? (
        <p className="panel-note">{events ? t('activity.empty') : t('chart.loading')}</p>
      ) : null}
    </Panel>
  );
}

function ActivityRow({
  event,
  onOpen,
  sources,
  tools,
  ctx,
}: {
  ctx?: Ctx;
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
  if (!event.group && ctx)
    return (
      <li className="activity-group">
        <details>
          <summary>{content}</summary>
          <EventDetails event={event} ctx={ctx} />
        </details>
      </li>
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
              ctx={ctx}
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

function ActivityError({ retry }: { retry: () => void }) {
  return (
    <p className="panel-note red" role="alert">
      {t('activity.error')}{' '}
      <button className="link" onClick={retry}>
        {t('common.retry')}
      </button>
    </p>
  );
}

function EventDetails({ event, ctx }: { event: DeckEvent; ctx: Ctx }) {
  const data = event.data;
  const job = eventJob(event);
  const live =
    job && ctx.data.jobs.find((item) => item.id === job.id && item.source_id === event.source_id);
  const source = ctx.data.sources.find((item) => item.id === event.source_id);
  const machine =
    event.type === 'change.instance' &&
    ctx.data.instances.find((item) => item.id === data.subject_id);
  const ended = data.ended_at ?? data.job?.end;
  const facts: [MessageKey, string | number | null | undefined][] = [
    ['jobs.col.state', job?.state ? statusLabel(job.state) : null],
    ['jobs.col.exitCode', job?.exit_code],
    ['job.node', job?.node],
    ['jobs.col.elapsed', job?.elapsed],
    ['jobs.col.ended', ended ? jobTime(ended) : null],
    ['event.observedAt', dateTime(data.observed_at ?? event.at)],
    ['activity.errorDetail', data.error ? formatMessage(data.error) : null],
  ];
  return (
    <div className="activity-details">
      <dl className="kv">
        {facts
          .filter(([, value]) => value != null && value !== '')
          .map(([key, value]) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <div className="activity-actions">
        {job && (
          <>
            <button
              className="link"
              onClick={() => (live ? ctx.openJob(live) : ctx.openEvent(event))}
            >
              {t(live ? 'activity.openJob' : 'activity.openSnapshot')}
            </button>
            <a
              className="link"
              href={`${routeHash('activity')}?job_filter=${encodeURIComponent(job.id)}&range=30d`}
            >
              {t('activity.jobHistory')}
            </a>
          </>
        )}
        {source && (
          <button className="link" onClick={() => ctx.diagnose(source)}>
            {t('activity.openSource')}
          </button>
        )}
        {machine && (
          <button className="link" onClick={() => ctx.openInstance(machine)}>
            {t('activity.openMachine')}
          </button>
        )}
        {event.type === 'change.node' && ctx.nodes.some((item) => item.id === data.subject_id) && (
          <a className="link" href={routeHash('sources')}>
            {t('activity.openSource')}
          </a>
        )}
      </div>
    </div>
  );
}

const categories = ['failed', 'jobs', 'sources', 'gaps', 'changes', 'plugins'] as const;
const pageSize = 30;

export function ActivityPage({ ctx }: { ctx: Ctx }) {
  const [requestedCategory, setCategory] = useRouteParam('type');
  const category = categories.includes(requestedCategory as (typeof categories)[number])
    ? requestedCategory
    : '';
  const [requestedRange, setRange] = useRouteParam('range', '24h');
  const range = ['24h', '7d', '30d'].includes(requestedRange) ? requestedRange : '24h';
  const { query } = ctx;
  const [job] = useRouteParam('job_filter');
  const [search, setSearch] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({
    demo: String(ctx.demo),
    group: '1',
    include: 'changes',
    range,
  });
  if (category) params.set('category', category);
  if (ctx.group !== 'all') params.set('cluster_id', ctx.group);
  if (search) params.set('q', search.slice(0, 64));
  if (job) params.set('job', job);
  const clear = () =>
    setRouteParams({ type: null, range: null, group: null, q: null, job_filter: null });
  return (
    <>
      <Panel>
        <div className="activity-filters">
          <Chips
            label={t('activity.eventType')}
            value={category}
            onChange={setCategory}
            options={[
              { value: '', label: t('filter.all') },
              ...categories.map((value) => ({ value, label: t(`activity.filter.${value}`) })),
            ]}
          />
          <Chips
            label={t('activity.range')}
            value={range}
            onChange={setRange}
            options={['24h', '7d', '30d'].map((value) => ({
              value,
              label: t(`activity.range.${value}` as MessageKey),
            }))}
          />
          <label>
            {t('filter.byGroup')}{' '}
            <select value={ctx.group} onChange={(event) => ctx.setGroup(event.target.value)}>
              <option value="all">{t('filter.all')}</option>
              {ctx.groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {group.label}
                </option>
              ))}
              {ctx.group !== 'all' && !ctx.groups.some((group) => group.key === ctx.group) && (
                <option value={ctx.group}>{ctx.group}</option>
              )}
            </select>
          </label>
          <SearchBox ctx={ctx} placeholder={t('activity.search')} maxLength={64} />
          {job && <p>{t('activity.forJob', { job: job.split(':').at(-1) })}</p>}
          {(category || query || job || ctx.group !== 'all' || range !== '24h') && (
            <button className="link" onClick={clear}>
              {t('activity.clear')}
            </button>
          )}
        </div>
      </Panel>
      <ActivityFeed
        key={params.toString()}
        query={params.toString()}
        ctx={ctx}
        filtered={Boolean(category || search || job || ctx.group !== 'all')}
        range={range}
        clear={clear}
      />
    </>
  );
}

function ActivityFeed({
  query,
  ctx,
  filtered,
  range,
  clear,
}: {
  query: string;
  ctx: Ctx;
  filtered: boolean;
  range: string;
  clear: () => void;
}) {
  const [rows, setRows] = useState<DeckEvent[] | null>(null);
  const [fresh, setFresh] = useState<DeckEvent[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const current = useRef<DeckEvent[] | null>(null);
  const active = useRef(true);
  const inFlight = useRef<'poll' | 'older' | 'reload' | null>(null);
  const loadId = useRef(0);
  const retry = useRef<'poll' | 'older' | 'reload'>('poll');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const load = useCallback(
    async (mode: 'poll' | 'older' | 'reload' = 'poll') => {
      // User actions can supersede a poll; a late poll must not overwrite their result.
      if (inFlight.current && (mode === 'poll' || inFlight.current !== 'poll')) return;
      inFlight.current = mode;
      const id = ++loadId.current;
      if (mode !== 'poll') setBusy(true);
      retry.current = mode;
      const previous = current.current;
      const checking = mode === 'poll' && previous !== null;
      const cursor =
        mode === 'older' && previous?.length
          ? `&before_id=${previous.at(-1)!.id}`
          : checking
            ? `&after_id=${previous[0]?.id ?? 0}`
            : '';
      try {
        const result = await api<DeckEvent[]>(
          `/events?${query}&limit=${checking ? 200 : pageSize}${cursor}`,
        );
        if (!active.current || id !== loadId.current) return;
        if (checking) setFresh(result);
        else {
          const next = mode === 'older' ? [...(previous ?? []), ...result] : result;
          current.current = next;
          setRows(next);
          setMore(result.length === pageSize);
          setFresh([]);
        }
        setError(false);
      } catch {
        if (active.current && id === loadId.current) setError(true);
      } finally {
        if (id === loadId.current) {
          inFlight.current = null;
          if (active.current && mode !== 'poll') setBusy(false);
        }
      }
    },
    [query],
  );
  useVisibleInterval(load, 15000, ctx.data.token);
  const days = new Map<string, DeckEvent[]>();
  for (const event of activityEvents(rows ?? [])) {
    const day = new Date(event.at).toLocaleDateString(locale(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const count = fresh.reduce(
    (total, event) =>
      total + (event.group ? event.group.ids.filter((id) => id > (rows?.[0]?.id ?? 0)).length : 1),
    0,
  );
  return (
    <Panel>
      {error && <ActivityError retry={() => void load(retry.current)} />}
      {rows === null && !error && (
        <p className="panel-note" role="status">
          {t('common.loading')}
        </p>
      )}
      {count > 0 && (
        <button className="button" onClick={() => void load('reload')} disabled={busy}>
          {t('activity.new', { count: `${fresh.length === 200 ? '≥ ' : ''}${count}` })}
        </button>
      )}
      {rows?.length === 0 && (
        <p className="panel-note">
          {t(
            filtered
              ? 'activity.filtered'
              : range === '30d'
                ? 'activity.empty'
                : range === '7d'
                  ? 'activity.empty7d'
                  : 'activity.empty24h',
          )}{' '}
          {filtered ? (
            <button className="link" onClick={clear}>
              {t('activity.clear')}
            </button>
          ) : (
            range !== '30d' && (
              <button className="link" onClick={() => setRouteParams({ range: '30d' })}>
                {t('activity.show30d')}
              </button>
            )
          )}
        </p>
      )}
      {[...days]
        .sort(([, a], [, b]) => Date.parse(b[0].at) - Date.parse(a[0].at))
        .map(([day, events]) => (
          <section key={day}>
            <h3 className="activity-day">{day}</h3>
            <ul className="activity">
              {events.map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  sources={ctx.data.sources}
                  tools={ctx.tools}
                  ctx={ctx}
                />
              ))}
            </ul>
          </section>
        ))}
      {more && (
        <button className="button" disabled={busy} onClick={() => void load('older')}>
          {t(busy ? 'common.loading' : 'activity.older')}
        </button>
      )}
    </Panel>
  );
}

const seenKey = 'computedeck.activity.seen';

export function ActivityTeaser({ ctx }: { ctx: Ctx }) {
  // Undefined means storage works but nothing has been marked; null means seen state is off.
  const [seen, setSeen] = useState<number | null | undefined>(() => {
    if (ctx.demo) return null;
    try {
      const stored = localStorage.getItem(seenKey);
      if (stored === null) return undefined;
      const saved = Number(stored);
      return Number.isSafeInteger(saved) && saved >= 0 ? saved : undefined;
    } catch {
      return null;
    }
  });
  const [rows, setRows] = useState<DeckEvent[] | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const id = ++generation.current;
    return api<DeckEvent[]>(
      `/events?demo=${ctx.demo}&include=changes&group=1&limit=50${seen !== null ? `&after_id=${seen ?? 0}` : ''}`,
    ).then(
      (result) => {
        if (generation.current === id) {
          setRows(result);
          setError(false);
        }
      },
      () => {
        if (generation.current === id) setError(true);
      },
    );
  }, [ctx.demo, seen]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [load],
  );
  useEffect(() => {
    void load();
  }, [load, ctx.data.token]);
  const mark = () => {
    if (ctx.demo || seen === null || !rows?.length) return;
    const newest = Math.max(...rows.map((event) => event.id));
    try {
      localStorage.setItem(seenKey, String(newest));
      setSeen(newest);
      setRows(null);
    } catch {
      setSeen(null);
    }
  };
  const shown = activityEvents(rows ?? [])
    .sort((a, b) => {
      const priority = (event: DeckEvent) =>
        eventTone(event) === 'red'
          ? 0
          : ['source.failed', 'source.recovered'].includes(event.type)
            ? 1
            : 2;
      return priority(a) - priority(b) || b.id - a.id;
    })
    .slice(0, 5);
  return (
    <Panel
      title={t(seen != null ? 'activity.sinceSeen' : 'activity.title')}
      actions={
        <div className="activity-actions">
          {seen !== null && !ctx.demo && Boolean(rows?.length) && (
            <button className="link" onClick={mark}>
              {t('activity.markSeen')}
            </button>
          )}
          <a className="link" href={routeHash('activity')}>
            {t('activity.all')}
          </a>
        </div>
      }
    >
      {error && <ActivityError retry={load} />}
      {shown.length ? (
        <ul className="activity">
          {shown.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              sources={ctx.data.sources}
              tools={ctx.tools}
              onOpen={ctx.openEvent}
            />
          ))}
        </ul>
      ) : rows || !error ? (
        <p className="panel-note">
          {rows ? t(seen != null ? 'activity.seenEmpty' : 'activity.empty') : t('common.loading')}
        </p>
      ) : null}
    </Panel>
  );
}
