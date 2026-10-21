import { routeParams, setRouteParams } from './useRouteParam';
import { computeHealth } from './health';
import { HealthPanel } from './HealthPanel';
import { SourceDiagnosis } from './SourceDiagnosis';
import { useVisibleInterval } from './useVisibleInterval';
import { useDialogFocus } from './useDialogFocus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Cable,
  Check,
  Cloud,
  Compass,
  Gauge,
  History,
  LayoutDashboard,
  Loader2,
  Menu,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Settings2,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import type {
  Attention,
  CollectionNode,
  Dashboard,
  DeckEvent,
  DriverInfo,
  Health,
  Instance,
  Job,
  Settings,
  Source,
  SSHConfig,
  Tool,
} from './types';
import { arrayLabel, dateTime, listedJobs, partialCount, uniqueJobs } from './domain';
import { clientSSHConfig } from './connections';
import { eventJob } from './events';
import { api } from './api';
import { groupsOf } from './groups';
import { ApiError, errorText, isLocale, setLocale, storeLocale, storedLocale, t } from './i18n';
import type { Locale, MessageKey } from './i18n';
import { corePages, readRoute, routeHash } from './routes';
import type { CorePage, Filter, Page } from './routes';
import {
  activePlugins,
  buildTimePlugins,
  labelText,
  loadBundles,
  pagesOf,
  useWebPlugins,
} from './plugins';
import type { PluginProps } from './plugins';
import { InstanceForm, SourceForm } from './forms';
import type { SourcePreset } from './forms';
import { TokenGate } from './TokenGate';
import { sessionRejected, setToken } from './token';
import { BrandMark, Status } from './ui';
import type { Ctx } from './pages/shared';
import { where } from './pages/util';
import { OverviewPage } from './pages/Overview';
import { ActivityPage } from './pages/Activity';
import { JobsPage } from './pages/Jobs';
import { ClustersPage } from './pages/Clusters';
import { CloudPage } from './pages/Cloud';
import { UsagePage } from './pages/Usage';
import { PlanPage } from './pages/Plan';
import { SourcesPage } from './pages/Sources';
import { SettingsPage } from './pages/Settings';
import { ToolboxPage } from './pages/Toolbox';
import { PageBoundary } from './PageBoundary';
import { NotifyPage } from './pages/Notify';
import { ChatPage } from './pages/Chat';
import { enabledToolPages } from './tools';
import { ArrayDetail, InstanceDetail, JobDetail, SSHConfigView } from './pages/Details';

type Modal =
  | { kind: 'instance'; item?: Instance }
  | { kind: 'source'; source?: Source; preset?: SourcePreset }
  | { kind: 'diagnosis'; sourceId: string }
  | { kind: 'ssh'; data: SSHConfig }
  | null;
type Detail =
  | { kind: 'job'; item: Job; event?: DeckEvent }
  | { kind: 'instance'; item: Instance }
  | { kind: 'array'; item: { id: string; name: string; jobs: Job[] } }
  | null;
type Toast = { text: string; tone: 'ok' | 'error' } | null;

const startPages = [...corePages, ...pagesOf(buildTimePlugins).map((page) => page.id)];
const navGroups: {
  label?: MessageKey;
  items: { id: CorePage; label: MessageKey; icon: typeof Server }[];
}[] = [
  {
    items: [
      { id: 'overview', label: 'nav.overview', icon: LayoutDashboard },
      { id: 'plan', label: 'nav.plan', icon: Compass },
    ],
  },
  {
    label: 'nav.resources',
    items: [
      { id: 'jobs', label: 'nav.jobs', icon: Activity },
      { id: 'activity', label: 'nav.activity', icon: History },
      { id: 'resources', label: 'nav.clusters', icon: Server },
      { id: 'cloud', label: 'nav.cloud', icon: Cloud },
      { id: 'usage', label: 'nav.usage', icon: Gauge },
    ],
  },
  {
    label: 'nav.setup',
    items: [
      { id: 'sources', label: 'nav.sources', icon: Cable },
      { id: 'toolbox', label: 'nav.toolbox', icon: Puzzle },
    ],
  },
];
const dataPages: Page[] = [
  'overview',
  'plan',
  'jobs',
  'activity',
  'resources',
  'cloud',
  'usage',
  'sources',
];
const pageTitles: Record<CorePage, MessageKey> = {
  overview: 'nav.overview',
  plan: 'nav.plan',
  sources: 'nav.sources',
  toolbox: 'nav.toolbox',
  notify: 'nav.notify',
  chat: 'nav.chat',
  jobs: 'nav.jobs',
  activity: 'nav.activity',
  resources: 'nav.clusters',
  cloud: 'nav.cloud',
  usage: 'nav.usage',
  settings: 'nav.settings',
};

function initialLocale(): Locale {
  const locale = storedLocale() ?? 'en';
  setLocale(locale);
  return locale;
}

/** "Group · login", or just the group when a source is named like its group. */
export default function App() {
  const remote = new URLSearchParams(window.location.search).get('remote') === '1';
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [hash, setHash] = useState(() => window.location.hash);
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
  const modalRef = useDialogFocus(undefined, !!modal);
  const detailRef = useDialogFocus(undefined, !!detailId);
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
    () => [...corePages, ...pagesOf(plugins).map((item) => item.id)],
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
  const notify = useCallback(
    (text: string, tone: 'ok' | 'error' = 'ok') => setToast({ text, tone }),
    [],
  );
  const serverName = demo
    ? t('where.local')
    : health?.server_name || health?.server_host || t('where.server');

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    storeLocale(next);
    setLocaleState(next);
  }, []);
  useEffect(() => {
    // The server's language applies until the viewer picks one on this device.
    if (storedLocale()) return;
    api<Settings>('/settings')
      .then((settings) => {
        if (isLocale(settings.language)) {
          setLocale(settings.language);
          setLocaleState(settings.language);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let previous = window.location.hash;
    const onHashChange = () => {
      const next = window.location.hash;
      setHash(next);
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
  const navigate = useCallback((next: Page, filter: Filter = 'all') => {
    const hash = routeHash(next, filter);
    if (window.location.hash === hash) setSidebarOpen(false);
    else window.location.hash = hash;
  }, []);
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
          if (!('unchanged' in next)) {
            dashboardToken.current = next.token;
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
    if (followUntil && Date.now() >= followUntil) {
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
  const followCollection = useCallback(() => setFollowUntil(Date.now() + 60000), []);
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
        followCollection();
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
      const followsCollection =
        path.endsWith('/probe') ||
        (method === 'POST' && (path === '/sources' || path === '/instances'));
      const result = await api<T>(path, body, method);
      if (followsCollection) followCollection();
      else await load();
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
      followCollection();
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
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(t('toast.copied'));
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
  const problems = data?.attention_count ?? attention.length;
  const diagnose = (source: Source) => setModal({ kind: 'diagnosis', sourceId: source.id });
  const diagnosisSource =
    modal?.kind === 'diagnosis'
      ? data?.sources.find((source) => source.id === modal.sourceId)
      : undefined;
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
  const jobCount = data ? partialCount(data.summary.jobs.total, data.summary.jobs.known) : 0;
  const isDataPage = dataPages.includes(page);
  const healthState = computeHealth(data, health, error, needsToken, demo, nodes);
  const healthDescription =
    healthState.label === healthState.age
      ? healthState.label
      : t('health.withAge', { label: healthState.label, age: healthState.age });
  const plugin: PluginProps = { request: api, demo, remote, locale, page, health, navigate };
  const activePluginPage = pluginPages.find((item) => item.id === page);
  const toolNav = enabledToolPages(tools);

  const ctx: Ctx | null = data
    ? {
        data,
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
      }
    : null;

  const pageActions: Partial<Record<Page, ReactNode>> = {
    sources: (
      <button className="button primary" aria-label={t('source.add')} onClick={() => configure()}>
        <Plus size={14} />
        <span className="label">{t('source.add')}</span>
      </button>
    ),
    resources: (
      <button
        className="button"
        aria-label={t('clusters.addAccount')}
        onClick={() => configure(undefined, { kind: 'cluster' })}
      >
        <Plus size={14} />
        <span className="label">{t('clusters.addAccount')}</span>
      </button>
    ),
    cloud: (
      <>
        <button className="button" aria-label={t('settings.ssh')} onClick={() => void showSSH()}>
          <Terminal size={14} />
          <span className="label">{t('settings.ssh')}</span>
        </button>
        <button className="button primary" aria-label={t('cloud.add')} onClick={addInstance}>
          <Plus size={14} />
          <span className="label">{t('cloud.add')}</span>
        </button>
      </>
    ),
  };
  const title = activePluginPage
    ? labelText(activePluginPage.label, locale)
    : t(pageTitles[page as CorePage] ?? 'nav.overview');

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="scrim"
          aria-label={t('nav.close')}
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <BrandMark size={20} />
          <strong className="brand-name">
            Compute<b>Deck</b>
          </strong>
          <span className="brand-mode">{remote ? t('mode.remote') : t('mode.local')}</span>
        </div>
        <nav aria-label={t('nav.main')}>
          {navGroups.map((navGroup, index) => (
            <div className="nav-group" key={index}>
              {navGroup.label && <div className="nav-label">{t(navGroup.label)}</div>}
              {navGroup.items.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={routeHash(id)}
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={16} />
                  <span>{t(label)}</span>
                  {id === 'overview' && problems > 0 && (
                    <b className="badge warn" title={t('nav.problems', { count: problems })}>
                      {problems}
                    </b>
                  )}
                  {id === 'jobs' && jobCount !== 0 && <b className="badge">{jobCount}</b>}
                </a>
              ))}
            </div>
          ))}
          {toolNav.length + pluginPages.length > 0 && (
            <div className="nav-group">
              <div className="nav-label">{t('nav.tools')}</div>
              {toolNav.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={routeHash(id)}
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={16} />
                  <span>{t(label)}</span>
                </a>
              ))}
              {pluginPages.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={routeHash(id)}
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={16} />
                  <span>{labelText(label, locale)}</span>
                </a>
              ))}
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
          <a
            href={routeHash('settings')}
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            <Settings2 size={16} />
            <span>{t('nav.settings')}</span>
          </a>
          <label className="demo-toggle">
            <span>{t('nav.demo')}</span>
            <input type="checkbox" role="switch" checked={demo} onChange={toggleDemo} />
            <i aria-hidden="true" />
          </label>
          <div className="service-state" role="status">
            <span className={`dot ${error ? 'red' : data ? 'green' : ''}`} />
            {needsToken
              ? t('token.title')
              : error
                ? remote
                  ? t('service.remoteDown', { server: serverName })
                  : t('service.localDown')
                : data
                  ? remote
                    ? t('service.remoteUp', { server: serverName })
                    : t('service.localUp')
                  : t('service.connecting')}
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label={t('nav.open')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <h1>{title}</h1>
          <div className="topbar-actions">
            <div className="health-status">
              <span className="sr-only" role="status">
                {healthState.label}
              </span>
              <button
                className={`health-pill health-${healthState.level}`}
                onClick={() => setHealthOpen(true)}
                aria-label={t('health.accessible', {
                  title: t('health.title'),
                  status: healthDescription,
                })}
                aria-haspopup="dialog"
                aria-expanded={healthOpen}
                title={
                  !needsToken && data?.as_of
                    ? t('health.withAge', { label: healthState.label, age: dateTime(data.as_of) })
                    : healthDescription
                }
              >
                <span aria-hidden="true">
                  {healthState.level === 'bad' ? '■' : healthState.level === 'warn' ? '▲' : '●'}
                </span>
                <span className="health-label">{healthDescription}</span>
                <span className="health-age" aria-hidden="true">
                  {healthState.age}
                </span>
              </button>
            </div>
            {!!data?.collecting?.length && !needsToken && (
              <span className="collecting-count">
                {t('health.collecting', { count: data.collecting.length })}
              </span>
            )}
            {!demo && pageActions[page]}
            {isDataPage && (
              <>
                <button
                  className="button"
                  onClick={() => void refresh()}
                  disabled={refreshing || needsToken}
                  title={t('topbar.refreshHint')}
                  aria-label={t('topbar.refresh')}
                >
                  <RefreshCw size={14} className={refreshing || data?.refreshing ? 'spin' : ''} />
                  <span className="label">{t('topbar.refresh')}</span>
                </button>
              </>
            )}
          </div>
        </header>
        {healthState.collectorFault && isDataPage && (
          <div className="banner red" role="alert">
            <TriangleAlert size={15} />
            <span>{t('health.collectorFault')}</span>
            <button className="link" onClick={() => setHealthOpen(true)}>
              {t('health.details')}
            </button>
          </div>
        )}
        {demo && (
          <div className="banner demo-banner">
            <span>{t(isDataPage ? 'banner.demo' : 'banner.demoTool')}</span>
            <button className="link" onClick={toggleDemo}>
              {t('banner.demoOff')}
            </button>
          </div>
        )}
        {error && isDataPage && !needsToken && (
          <div className="banner red" role="alert">
            <TriangleAlert size={15} />
            <span>
              {remote
                ? t('banner.remoteDown', { server: serverName, error })
                : t('banner.localDown', { error })}
            </span>
            <button className="link" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        )}
        {!demo &&
          plugins
            .filter((item) => item.banner)
            .map((item) => {
              const Banner = item.banner!;
              return <Banner key={item.id} {...plugin} />;
            })}
        <main className={`content page-${page}`}>
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
              loading && (
                <div className="loading">
                  <Loader2 className="spin" size={18} />
                  {t('common.loading')}
                </div>
              )
            ) : page === 'overview' ? (
              <OverviewPage ctx={ctx} />
            ) : page === 'jobs' ? (
              <JobsPage ctx={ctx} />
            ) : page === 'activity' ? (
              <ActivityPage ctx={ctx} />
            ) : page === 'resources' ? (
              <ClustersPage ctx={ctx} />
            ) : page === 'cloud' ? (
              <CloudPage ctx={ctx} />
            ) : page === 'usage' ? (
              <UsagePage ctx={ctx} />
            ) : page === 'plan' ? (
              <PlanPage ctx={ctx} />
            ) : page === 'sources' ? (
              <SourcesPage ctx={ctx} />
            ) : page === 'toolbox' ? (
              <ToolboxPage ctx={ctx} />
            ) : page === 'notify' ? (
              <NotifyPage ctx={ctx} />
            ) : page === 'chat' ? (
              <ChatPage ctx={ctx} />
            ) : (
              <SettingsPage ctx={ctx} />
            )}
          </PageBoundary>
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' ? <TriangleAlert size={15} /> : <Check size={15} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label={t('common.dismiss')}
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {healthOpen && (
        <HealthPanel
          state={healthState}
          data={data}
          busy={refreshing || needsToken}
          refresh={refresh}
          close={() => setHealthOpen(false)}
        />
      )}
      {modal && (
        <div className="overlay" onMouseDown={() => setModal(null)}>
          <section
            className={`modal ${modal.kind === 'ssh' ? 'wide' : ''}`}
            ref={modalRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              aria-label={t('common.close')}
              onClick={() => setModal(null)}
            >
              <X size={16} />
            </button>
            {modal.kind === 'diagnosis' &&
              (diagnosisSource ? (
                <SourceDiagnosis
                  key={diagnosisSource.id}
                  source={diagnosisSource}
                  configure={() => configure(diagnosisSource)}
                  collect={() => collect(diagnosisSource)}
                  collecting={data?.collecting?.includes(diagnosisSource.id)}
                  demo={demo}
                  drivers={drivers}
                />
              ) : (
                <h2 id="modal-title">{t('msg.source_not_found')}</h2>
              ))}
            {modal.kind === 'instance' && (
              <InstanceForm
                item={modal.item}
                platforms={[
                  ...new Set(
                    (data?.instances ?? [])
                      .filter((item) => item.manual)
                      .map((item) => item.platform),
                  ),
                ]}
                where={where({ remote, serverName })}
                busy={busy}
                onCancel={() => setModal(null)}
                onSubmit={async (body) => {
                  await mutate(
                    modal.item ? `/instances/${encodeURIComponent(modal.item.id)}` : '/instances',
                    body,
                    modal.item ? 'PUT' : 'POST',
                  );
                  setModal(null);
                  setDetail(null);
                  notify(
                    remote ? t('toast.savedRemote', { server: serverName }) : t('toast.savedSsh'),
                  );
                  navigate('cloud');
                }}
              />
            )}
            {modal.kind === 'source' && (
              <SourceForm
                source={modal.source}
                preset={modal.preset}
                drivers={drivers}
                nodes={nodes}
                sources={data?.sources ?? []}
                groups={groups}
                where={where({ remote, serverName })}
                busy={busy}
                onCancel={() => setModal(null)}
                onManual={() => setModal({ kind: 'instance' })}
                onDelete={async (source) => {
                  await mutate(`/sources/${encodeURIComponent(source.id)}`, {}, 'DELETE');
                  setModal(null);
                  notify(t('toast.sourceRemoved', { name: source.name }));
                }}
                onSubmit={async (body, id) => {
                  const saved = await mutate<Source>(
                    id ? `/sources/${encodeURIComponent(id)}` : '/sources',
                    body,
                    id ? 'PUT' : 'POST',
                  );
                  if (saved.enabled) {
                    await api('/refresh', { source_id: saved.id });
                    followCollection();
                  }
                  await load();
                  if (modal.source) notify(t('toast.sourceSaved'));
                  return saved;
                }}
              />
            )}
            {modal.kind === 'ssh' && (
              <SSHConfigView
                config={modal.data}
                remote={remote}
                serverName={serverName}
                busy={busy}
                onInstall={async () => {
                  try {
                    await mutate('/ssh/install', { confirm: true });
                    setModal({ kind: 'ssh', data: await api<SSHConfig>('/ssh/config') });
                    notify(t('toast.includeInstalled'));
                  } catch (reason) {
                    notify(errorText(reason, 'error.sshConfig'), 'error');
                  }
                }}
              />
            )}
          </section>
        </div>
      )}
      {detailId && !detail && ctx && (
        <div className="drawer-overlay" onMouseDown={closeDetail}>
          <aside
            className="drawer"
            ref={detailRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="detail-title">
              {t(eventId && eventLoad === 'loading' ? 'chart.loading' : 'drawer.unavailable')}
            </h2>
            <p>
              {t(eventId && eventLoad === 'error' ? 'event.loadError' : 'drawer.unavailableHint')}
            </p>
            <button className="button" onClick={closeDetail}>
              {t('common.close')}
            </button>
          </aside>
        </div>
      )}
      {detail && ctx && (
        <div className="drawer-overlay" onMouseDown={closeDetail}>
          <aside
            className="drawer"
            ref={detailRef}
            tabIndex={-1}
            role="dialog"
            aria-modal={!modal}
            aria-labelledby="detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="drawer-header">
              <div>
                <span className="drawer-kind">
                  {detail.kind === 'job'
                    ? t('drawer.job')
                    : detail.kind === 'array'
                      ? t('drawer.array')
                      : t('drawer.instance')}
                </span>
                <h2 id="detail-title">{detail.item.name}</h2>
                {detail.kind !== 'array' && <Status state={detail.item.state} />}
              </div>
              <button className="icon-button" aria-label={t('common.close')} onClick={closeDetail}>
                <X size={16} />
              </button>
            </header>
            {detail.kind === 'array' ? (
              <ArrayDetail key={detail.item.id} jobs={detail.item.jobs} ctx={ctx} />
            ) : detail.kind === 'job' ? (
              <JobDetail job={detail.item} ctx={ctx} event={detail.event} />
            ) : (
              <InstanceDetail
                item={detail.item}
                ctx={ctx}
                onProbe={async () => {
                  try {
                    const item = await mutate<Instance>(
                      `/instances/${encodeURIComponent(detail.item.id)}/probe`,
                      {},
                    );
                    setData(
                      (current) =>
                        current && {
                          ...current,
                          instances: current.instances.map((row) =>
                            row.id === item.id ? item : row,
                          ),
                        },
                    );
                    notify(t('toast.probed'));
                  } catch (reason) {
                    notify(errorText(reason, 'error.probe'), 'error');
                  }
                }}
                onEdit={() => setModal({ kind: 'instance', item: detail.item })}
                onDelete={async () => {
                  try {
                    await mutate(`/instances/${encodeURIComponent(detail.item.id)}`, {}, 'DELETE');
                    setDetail(null);
                    notify(t('toast.instanceRemoved', { name: detail.item.name }));
                  } catch (reason) {
                    notify(errorText(reason, 'error.save'), 'error');
                  }
                }}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
