import { routeParams, setRouteParams } from './useRouteParam';
import { computeHealth } from './health';
import { useVisibleInterval } from './useVisibleInterval';
import { LocaleGate } from './app/LocaleGate';
import { Frame } from './app/Frame';
import { Layers } from './app/Layers';
import type { Modal, Detail, Toast } from './app/Layers';
import { Routes } from './app/Routes';
import { Loading } from './app/LoadState';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Attention,
  CollectionNode,
  Dashboard,
  DeckEvent,
  DriverInfo,
  Health,
  Settings,
  Source,
  SSHConfig,
  Tool,
} from './types';
import { arrayLabel, listedJobs, uniqueJobs } from './domain';
import { clientSSHConfig } from './connections';
import { eventJob } from './events';
import { api } from './api';
import { groupsOf } from './groups';
import {
  ApiError,
  errorText,
  isLocale,
  loadLocale,
  setLocale,
  storeLocale,
  storedLocale,
  t,
} from './i18n';
import type { Locale } from './i18n';
import { canonicalHash, corePages, readRoute, routeHash, useHash } from './routes';
import type { Filter, Page } from './routes';
import { activePlugins, buildTimePlugins, loadBundles, pagesOf, useWebPlugins } from './plugins';
import type { PluginProps } from './plugins';
import type { SourcePreset } from './forms';
import { TokenGate } from './TokenGate';
import { sessionRejected, setToken } from './token';
import type { Ctx } from './pages/shared';
import { where } from './pages/util';
import { PageBoundary } from './PageBoundary';

const startPages = [...corePages, '__gallery', ...pagesOf(buildTimePlugins).map((page) => page.id)];

function initialLocale(): Locale {
  const locale = storedLocale() ?? 'en';
  setLocale(locale);
  return locale;
}

export default function App() {
  return (
    <LocaleGate>
      <Application />
    </LocaleGate>
  );
}

function Application() {
  const remote = new URLSearchParams(window.location.search).get('remote') === '1';
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const hash = useHash();
  const group = readRoute(startPages, hash).group;
  const query = routeParams(hash).get('q') ?? '';
  const setQuery = (value: string) => setRouteParams({ q: value });
  const [demo, setDemo] = useState(
    () => new URLSearchParams(window.location.search).get('demo') === 'true',
  );
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const params = routeParams(hash);
  const eventId = params.get('event');
  const [selectedEvent, setSelectedEvent] = useState<{ demo: boolean; event: DeckEvent } | null>(
    null,
  );
  const selected =
    selectedEvent?.demo === demo && String(selectedEvent.event.id) === eventId
      ? selectedEvent.event
      : null;
  const [eventResult, setEventResult] = useState<{
    id: string;
    demo: boolean;
    status: 'error' | 'done';
  } | null>(null);
  const eventLoad =
    eventResult?.id === eventId && eventResult.demo === demo ? eventResult.status : 'loading';
  useEffect(() => {
    if (!eventId || selected) return;
    let cancelled = false;
    void api<DeckEvent[]>(`/events?id=${encodeURIComponent(eventId)}&demo=${demo}`).then(
      (rows) => {
        if (cancelled) return;
        if (rows[0]) setSelectedEvent({ demo, event: rows[0] });
        setEventResult({ id: eventId, demo, status: 'done' });
      },
      () => {
        if (!cancelled) setEventResult({ id: eventId, demo, status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [eventId, demo, selected]);
  const historicalJob = selected ? eventJob(selected) : null;
  const detailId =
    params.get('job') ||
    params.get('failure') ||
    params.get('instance') ||
    params.get('array') ||
    eventId;
  const job = params.get('failure')
    ? data?.recent_failures?.find((item) => item.id === params.get('failure'))
    : params.get('job')
      ? data && uniqueJobs(data.jobs).find((item) => item.id === params.get('job'))
      : null;
  const instance = params.get('instance')
    ? data?.instances.find((item) => item.id === params.get('instance'))
    : null;
  const arrayJobs =
    params.get('array') && data
      ? listedJobs(data).jobs.filter(
          (item) => item.array_id && `${item.cluster_id}:${item.array_id}` === params.get('array'),
        )
      : [];
  const detail: Detail =
    historicalJob && selected
      ? { kind: 'job', item: historicalJob, event: selected }
      : job
        ? { kind: 'job', item: job }
        : instance
          ? { kind: 'instance', item: instance }
          : arrayJobs.length
            ? {
                kind: 'array',
                item: {
                  id: params.get('array')!,
                  name: `${arrayJobs[0].name} ${arrayLabel(arrayJobs[0].array_id!)}`,
                  jobs: arrayJobs,
                },
              }
            : null;
  const setDetail = useCallback(
    (next: Detail) => {
      const failure =
        next?.kind === 'job' &&
        (!!next.item.end || data?.recent_failures?.some((item) => item === next.item));
      setRouteParams(
        {
          event: null,
          job: next?.kind === 'job' && !failure ? next.item.id : null,
          failure: next?.kind === 'job' && failure ? next.item.id : null,
          instance: next?.kind === 'instance' ? next.item.id : null,
          array: next?.kind === 'array' ? next.item.id : null,
        },
        !!next,
      );
    },
    [data?.recent_failures],
  );
  const closeDetail = useCallback(() => {
    if (window.history.state?.detail) window.history.back();
    else setDetail(null);
  }, [setDetail]);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [nodes, setNodes] = useState<CollectionNode[]>([]);
  const allPlugins = useWebPlugins();
  const plugins = useMemo(() => activePlugins(allPlugins, tools), [allPlugins, tools]);
  const pluginPages = pagesOf(plugins);
  const knownPages = useMemo(
    () => [...corePages, '__gallery', ...pagesOf(plugins).map((item) => item.id)],
    [plugins],
  );
  // Re-evaluate the requested route as plugin pages become available or disappear.
  const page = readRoute(knownPages, hash).page;
  useEffect(() => {
    loadBundles(tools.filter((tool) => tool.enabled && tool.web).map((tool) => tool.web as string));
  }, [tools]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const driversLoaded = useRef(false);
  const dashboardToken = useRef<string | undefined>(undefined);
  const lastAuxLoad = useRef(-Infinity);
  const activePoll = useRef<{ startedAt: number; promise: Promise<void> } | null>(null);
  const [followUntil, setFollowUntil] = useState(0);
  const followSources = useRef<string[] | null>(null);
  const latestCollecting = useRef<string[]>([]);
  const followLoaded = useRef(false);
  const notify = useCallback(
    (text: string, tone: 'ok' | 'error' = 'ok') => setToast({ text, tone }),
    [setToast],
  );
  const serverName = demo
    ? t('where.local')
    : health?.server_name || health?.server_host || t('where.server');

  const localeChange = useRef(0);
  const changeLocale = useCallback(
    (next: Locale) => {
      const request = ++localeChange.current;
      void loadLocale(next)
        .then(() => {
          if (request !== localeChange.current) return;
          setLocale(next);
          storeLocale(next);
          setLocaleState(next);
        })
        .catch(() => {
          if (request === localeChange.current) notify(t('error.locale'), 'error');
        });
    },
    [notify],
  );
  useEffect(() => {
    // The server's language applies until the viewer picks one on this device.
    if (storedLocale()) return;
    let cancelled = false;
    const request = localeChange.current;
    void api<Settings>('/settings')
      .then(async (settings) => {
        if (
          cancelled ||
          storedLocale() ||
          request !== localeChange.current ||
          !isLocale(settings.language)
        )
          return;
        await loadLocale(settings.language);
        if (cancelled || storedLocale() || request !== localeChange.current) return;
        setLocale(settings.language);
        setLocaleState(settings.language);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(
    () => () => {
      localeChange.current += 1;
    },
    [],
  );

  useEffect(() => {
    let previous = canonicalHash(window.location.hash);
    const onHashChange = () => {
      const next = canonicalHash(window.location.hash);
      if (previous.split('?')[0] !== next.split('?')[0]) {
        setSidebarOpen(false);
        setModal(null);
        window.scrollTo(0, 0);
      }
      previous = next;
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);
  const navigate = useCallback(
    (next: Page, filter: Filter = 'all') => {
      const hash = routeHash(next, filter);
      if (window.location.hash === hash) setSidebarOpen(false);
      else window.location.hash = hash;
    },
    [setSidebarOpen],
  );
  const setGroup = (filter: Filter) => {
    setRouteParams({ group: filter === 'all' ? null : filter, provider: null });
  };

  const load = useCallback(
    (dashboardOnly = false) => {
      if (document.hidden) return Promise.resolve();
      loadId.current += 1;
      const requestId = loadId.current;
      const requestedAt = Date.now();
      return Promise.all([
        api<Dashboard | { unchanged: true; token: string }>(
          `/dashboard?demo=${demo}${dashboardToken.current ? `&since=${dashboardToken.current}` : ''}`,
        ),
        // Health also carries plugin state; a failure here must not hide the dashboard.
        dashboardOnly ? null : api<Health>('/health').catch(() => null),
        dashboardOnly ? null : api<Tool[]>('/toolbox').catch(() => null),
        dashboardOnly ? null : api<CollectionNode[]>(`/nodes?demo=${demo}`).catch(() => null),
      ])
        .then(([next, status, toolbox, machines]) => {
          if (requestId !== loadId.current) return;
          followLoaded.current = true;
          if (!('unchanged' in next)) {
            dashboardToken.current = next.token;
            latestCollecting.current = next.collecting ?? [];
            setData(next);
          }
          if (!dashboardOnly) {
            lastAuxLoad.current = requestedAt;
            setHealth(status);
          }
          if (toolbox) setTools(toolbox);
          if (machines) setNodes(machines);
          // Driver descriptions do not change while the service runs; fetch them once.
          if (!document.hidden && !driversLoaded.current) {
            driversLoaded.current = true;
            api<DriverInfo[]>('/drivers')
              .then(setDrivers)
              .catch(() => {
                driversLoaded.current = false;
              });
          }
          setError(null);
          setNeedsToken(false);
        })
        .catch((reason) => {
          if (requestId !== loadId.current) return;
          setNeedsToken(reason instanceof ApiError && reason.status === 401);
          setError(errorText(reason, 'error.service'));
        })
        .finally(() => {
          if (requestId === loadId.current) setLoading(false);
        });
    },
    [demo, setData],
  );
  useEffect(
    () => () => {
      loadId.current += 1;
      activePoll.current = null;
    },
    [load],
  );
  const poll = useCallback(() => {
    if (
      followUntil &&
      (Date.now() >= followUntil ||
        (followLoaded.current &&
          !latestCollecting.current.some(
            (id) => followSources.current === null || followSources.current.includes(id),
          )))
    ) {
      setFollowUntil(0);
      return;
    }
    // Give slow replies time to finish, but let polling recover from a stalled tunnel.
    const startedAt = Date.now();
    if (activePoll.current && startedAt - activePoll.current.startedAt < 10000) return;
    const pending = load(!!followUntil && startedAt - lastAuxLoad.current < 10000);
    activePoll.current = { startedAt, promise: pending };
    return pending.finally(() => {
      if (activePoll.current?.promise === pending) activePoll.current = null;
    });
  }, [load, followUntil]);
  useVisibleInterval(poll, followUntil ? 1000 : 10000);
  const followCollection = useCallback((sourceIds: string[] | null = null) => {
    followSources.current = sourceIds;
    followLoaded.current = false;
    // A poll started before this action cannot tell us whether its collection finished.
    loadId.current += 1;
    activePoll.current = null;
    setFollowUntil(Date.now() + 60000);
  }, []);
  const [, setClock] = useState(Date.now);
  const tickClock = useCallback(() => setClock(Date.now()), []);
  useVisibleInterval(tickClock, 30000);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 12000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (modal) setModal(null);
        else if (detailId) closeDetail();
        else setSidebarOpen(false);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'k' && searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [modal, detailId, closeDetail]);

  async function refresh(sourceId?: string) {
    setRefreshing(true);
    try {
      if (demo) {
        notify(t('toast.demoReloaded'));
        await load();
      } else {
        const result = await api<{ status: string }>(
          '/refresh',
          sourceId ? { source_id: sourceId } : {},
        );
        followCollection(sourceId ? [sourceId] : null);
        notify(result.status === 'running' ? t('toast.collecting') : t('toast.collectStarted'));
      }
    } catch (reason) {
      notify(errorText(reason, 'error.refresh'), 'error');
    } finally {
      setRefreshing(false);
    }
  }
  async function mutate<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    setBusy(true);
    try {
      const result = await api<T>(path, body, method);
      await load();
      return result;
    } finally {
      setBusy(false);
    }
  }
  async function updateTool(id: string, body: unknown): Promise<Tool> {
    const saved = await api<Tool>(`/toolbox/${encodeURIComponent(id)}`, body, 'PUT');
    setTools((current) => current.map((tool) => (tool.id === id ? saved : tool)));
    return saved;
  }
  const blockedInDemo = () => {
    if (demo) notify(t('toast.demoReadOnly'), 'error');
    return demo;
  };
  async function showSSH() {
    if (blockedInDemo()) return;
    try {
      setModal({
        kind: 'ssh',
        data: remote
          ? {
              config: clientSSHConfig(data?.instances ?? []),
              path: t('ssh.downloadPath'),
              installed: false,
            }
          : await api<SSHConfig>('/ssh/config'),
      });
    } catch (reason) {
      notify(errorText(reason, 'error.sshConfig'), 'error');
    }
  }
  const configure = (source?: Source, preset?: SourcePreset) => {
    if (!blockedInDemo()) setModal({ kind: 'source', source, preset });
  };
  async function collect(source: Source) {
    try {
      await api('/refresh', { source_id: source.id });
      followCollection([source.id]);
      notify(
        t('toast.collectSource', { name: `${source.name} · ${source.username || source.driver}` }),
      );
    } catch (reason) {
      notify(errorText(reason, 'error.refresh'), 'error');
    }
  }
  const addInstance = () => {
    if (!blockedInDemo()) setModal({ kind: 'instance' });
  };
  const copy = async (text: string, message?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(message ?? t('toast.copied'));
    } catch {
      notify(t('toast.clipboard'), 'error');
    }
  };
  async function backup() {
    try {
      const result = await mutate<{ path: string }>('/backup', {});
      notify(t(remote ? 'toast.backupRemote' : 'toast.backup', { path: result.path }));
    } catch (reason) {
      notify(errorText(reason, 'error.backup'), 'error');
    }
  }
  const toggleDemo = () => {
    loadId.current += 1;
    dashboardToken.current = undefined;
    lastAuxLoad.current = -Infinity;
    setFollowUntil(0);
    setData(null);
    setLoading(true);
    const next = !demo;
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('demo', 'true');
    else url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
    setDemo(next);
    setModal(null);
    setDetail(null);
    setHealthOpen(false);
    setRouteParams({ group: null, provider: null, q: null });
  };

  const groups = useMemo(
    () => (data ? groupsOf(data) : []),
    // Labels are recomputed with the data; the locale does not affect them.
    [data],
  );
  const attention = data?.attention ?? [];
  const diagnose = (source: Source) => setModal({ kind: 'diagnosis', sourceId: source.id });
  const openAttention = (item: Attention) => {
    if (item.action === 'diagnose') {
      const source = data?.sources.find((source) => source.id === item.subject.id);
      if (source) diagnose(source);
    } else if (item.action === 'instance') {
      const instance = data?.instances.find((instance) => instance.id === item.subject.id);
      if (instance) setDetail({ kind: 'instance', item: instance });
    } else if (item.action === 'notify') navigate('notify');
    else if (item.action === 'toolbox') navigate('toolbox');
    else setHealthOpen(true);
  };
  const healthState = computeHealth(data, health, error, needsToken, demo, nodes);
  const plugin: PluginProps = { request: api, demo, remote, locale, page, health, navigate };
  const activePluginPage = pluginPages.find((item) => item.id === page);

  const context: Omit<Ctx, 'data'> = {
    groups,
    demo,
    remote,
    serverName,
    busy,
    group,
    setGroup,
    query,
    setQuery,
    searchRef,
    attention,
    openAttention,
    diagnose,
    health,
    locale,
    changeLocale,
    plugin,
    navigate,
    webPlugins: plugins,
    drivers,
    nodes,
    reload: load,
    tools,
    updateTool,
    configure,
    collect,
    addInstance,
    showSSH,
    openJob: (item) => setDetail({ kind: 'job', item }),
    openEvent: (event) => {
      setSelectedEvent({ demo, event });
      setRouteParams(
        { event: String(event.id), job: null, failure: null, instance: null, array: null },
        true,
      );
    },
    openArray: (item) => setDetail({ kind: 'array', item }),
    openInstance: (item) => setDetail({ kind: 'instance', item }),
    copy,
    notify,
    backup,
    toggleDemo,
  };
  const ctx: Ctx | null = data ? { ...context, data } : null;

  return (
    <div className="app-shell">
      <Frame
        ctx={context}
        data={data}
        page={page}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        healthOpen={healthOpen}
        setHealthOpen={setHealthOpen}
        healthState={healthState}
        error={error}
        needsToken={needsToken}
        refreshing={refreshing}
        refresh={refresh}
      >
        <main className={`content page-${page}`} aria-busy={loading || refreshing}>
          <PageBoundary page={page}>
            {needsToken ? (
              <TokenGate
                where={where({ remote, serverName })}
                rejected={sessionRejected()}
                onSave={async (value) => {
                  const session = await api<{ token: string }>('/session', { token: value });
                  setToken(session.token);
                  setLoading(true);
                  await load();
                }}
              />
            ) : activePluginPage ? (
              activePluginPage.render(plugin)
            ) : !ctx ? (
              loading && <Loading />
            ) : (
              <Routes page={page} ctx={ctx} compat={params.has('compat')} />
            )}
          </PageBoundary>
        </main>
      </Frame>
      <Layers
        ctx={{ ...context, data }}
        modal={modal}
        setModal={setModal}
        detail={detail}
        setDetail={setDetail}
        detailId={detailId}
        closeDetail={closeDetail}
        eventId={eventId}
        eventLoad={eventLoad}
        toast={toast}
        setToast={setToast}
        healthOpen={healthOpen}
        setHealthOpen={setHealthOpen}
        healthState={healthState}
        needsToken={needsToken}
        refreshing={refreshing}
        refresh={refresh}
        mutate={mutate}
        followCollection={followCollection}
      />
    </div>
  );
}
