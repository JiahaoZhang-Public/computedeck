import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  Cable,
  Check,
  Cloud,
  Compass,
  Gauge,
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
  CollectionNode,
  Dashboard,
  DriverInfo,
  Health,
  Instance,
  Job,
  Settings,
  Source,
  SSHConfig,
  Tool,
} from './types';
import { relativeTime, uniqueJobs } from './domain';
import { clientSSHConfig } from './connections';
import { api } from './api';
import { groupsOf, sourceLabel } from './groups';
import {
  ApiError,
  errorText,
  formatMessage,
  isLocale,
  setLocale,
  storeLocale,
  storedLocale,
  t,
} from './i18n';
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
import type { Attention, Ctx } from './pages/shared';
import { where } from './pages/util';
import { OverviewPage } from './pages/Overview';
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
import { InstanceDetail, JobDetail, SSHConfigView } from './pages/Details';

type Modal =
  | { kind: 'instance'; item?: Instance }
  | { kind: 'source'; source?: Source; preset?: SourcePreset }
  | { kind: 'ssh'; data: SSHConfig }
  | null;
type Detail = { kind: 'job'; item: Job } | { kind: 'instance'; item: Instance } | null;
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
  'resources',
  'cloud',
  'usage',
  'sources',
  'toolbox',
  'settings',
];
const pageTitles: Record<CorePage, MessageKey> = {
  overview: 'nav.overview',
  plan: 'nav.plan',
  sources: 'nav.sources',
  toolbox: 'nav.toolbox',
  notify: 'nav.notify',
  chat: 'nav.chat',
  jobs: 'nav.jobs',
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
  const [route, setRoute] = useState(() => readRoute(startPages));
  const page = route.page;
  const [group, setGroupState] = useState<Filter>(route.group);
  const [query, setQuery] = useState('');
  const [demo, setDemo] = useState(
    () => new URLSearchParams(window.location.search).get('demo') === 'true',
  );
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [detail, setDetail] = useState<Detail>(null);
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
  const knownRef = useRef(knownPages);
  useEffect(() => {
    // A plugin page becomes reachable once its bundle registers and its tool is on.
    knownRef.current = knownPages;
    const next = readRoute(knownPages);
    setRoute((current) => (current.page === next.page ? current : next));
  }, [knownPages]);
  useEffect(() => {
    loadBundles(tools.filter((tool) => tool.enabled && tool.web).map((tool) => tool.web as string));
  }, [tools]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const driversLoaded = useRef(false);
  const notify = useCallback(
    (text: string, tone: 'ok' | 'error' = 'ok') => setToast({ text, tone }),
    [],
  );
  const serverName = health?.server_name || health?.server_host || t('where.server');

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
    const onHashChange = () => {
      const next = readRoute(knownRef.current);
      setRoute(next);
      setGroupState(next.group);
      setQuery('');
      setSidebarOpen(false);
      setDetail(null);
      setModal(null);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const navigate = useCallback((next: Page, filter: Filter = 'all') => {
    const hash = routeHash(next, filter);
    if (window.location.hash === hash) setSidebarOpen(false);
    else window.location.hash = hash;
  }, []);
  const setGroup = (filter: Filter) => {
    setGroupState(filter);
    window.history.replaceState(null, '', routeHash(page, filter));
  };

  const load = useCallback(async () => {
    const requestId = ++loadId.current;
    try {
      const [next, status, toolbox, machines] = await Promise.all([
        api<Dashboard>(`/dashboard?demo=${demo}`),
        // Health also carries plugin state; a failure here must not hide the dashboard.
        api<Health>('/health').catch(() => null),
        api<Tool[]>('/toolbox').catch(() => null),
        api<CollectionNode[]>(`/nodes?demo=${demo}`).catch(() => null),
      ]);
      if (requestId !== loadId.current) return;
      setData(next);
      setHealth(status);
      if (toolbox) setTools(toolbox);
      if (machines) setNodes(machines);
      // Driver descriptions do not change while the service runs; fetch them once.
      if (!driversLoaded.current) {
        driversLoaded.current = true;
        api<DriverInfo[]>('/drivers')
          .then(setDrivers)
          .catch(() => {
            driversLoaded.current = false;
          });
      }
      setError(null);
      setNeedsToken(false);
    } catch (reason) {
      if (requestId !== loadId.current) return;
      setNeedsToken(reason instanceof ApiError && reason.status === 401);
      setError(errorText(reason, 'error.service'));
    } finally {
      if (requestId === loadId.current) setLoading(false);
    }
  }, [demo]);
  useEffect(() => {
    setData(null);
    setLoading(true);
    void load();
    const interval = window.setInterval(() => void load(), 10000);
    return () => clearInterval(interval);
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 12000 : 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (modal) setModal(null);
        else if (detail) setDetail(null);
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
  }, [modal, detail]);

  async function refresh() {
    setRefreshing(true);
    try {
      if (demo) notify(t('toast.demoReloaded'));
      else {
        const result = await api<{ status: string }>('/refresh', {});
        notify(result.status === 'running' ? t('toast.collecting') : t('toast.collectStarted'));
      }
      await load();
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
    if (blockedInDemo()) throw new Error(t('toast.demoReadOnly'));
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
      notify(
        t('toast.collectSource', { name: `${source.name} · ${source.username || source.driver}` }),
      );
      await load();
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
    setDemo((value) => !value);
    setGroupState('all');
    setQuery('');
  };

  const groups = useMemo(
    () => (data ? groupsOf(data) : []),
    // Labels are recomputed with the data; the locale does not affect them.
    [data],
  );
  const attention: Attention[] = data
    ? [
        ...data.sources
          // A disabled login is not collected, so its old error or age needs no attention.
          .filter(
            (source) => source.enabled && (source.error || source.stale || source.warnings?.length),
          )
          .map((source) => ({
            id: `source:${source.id}`,
            tone: source.error ? ('red' as const) : ('amber' as const),
            title: t(
              source.error
                ? 'attention.failed'
                : source.stale
                  ? 'attention.stale'
                  : 'attention.partial',
              { name: sourceLabel(groups, source) },
            ),
            text:
              formatMessage(source.error) ||
              formatMessage(source.warnings?.[0]) ||
              t('attention.lastSuccess', { time: relativeTime(source.last_success) }),
            action: () => configure(source),
          })),
        ...data.instances
          .filter((item) => item.ssh_status === 'error')
          .map((item) => ({
            id: `instance:${item.id}`,
            tone: 'red' as const,
            title: t('attention.sshFailed', { name: item.name }),
            text: formatMessage(item.ssh_error) || t('attention.sshFailedHint'),
            action: () => setDetail({ kind: 'instance', item }),
          })),
        ...data.instances
          .filter((item) => item.ssh_status === 'unverified' && item.host && item.port)
          .map((item) => ({
            id: `instance:${item.id}`,
            tone: 'gray' as const,
            title: t('attention.unverified', { name: item.name }),
            text: t('attention.unverifiedHint'),
            action: () => setDetail({ kind: 'instance', item }),
          })),
      ]
    : [];
  const problems = attention.filter((item) => item.tone !== 'gray').length;
  const jobCount = data ? uniqueJobs(data.jobs).length : 0;
  const isDataPage = dataPages.includes(page);
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
                  {id === 'jobs' && jobCount > 0 && <b className="badge">{jobCount}</b>}
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
            {!demo && pageActions[page]}
            {isDataPage && (
              <>
                <span className="sync-time" title={data?.updated_at ?? ''}>
                  {data?.refreshing
                    ? t('topbar.collecting')
                    : data?.updated_at
                      ? t('common.updated', { time: relativeTime(data.updated_at) })
                      : t('time.never')}
                </span>
                <button
                  className="button"
                  onClick={() => void refresh()}
                  disabled={refreshing || !!data?.refreshing}
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
        {demo && isDataPage && (
          <div className="banner amber">
            <span>{t('banner.demo')}</span>
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
      {modal && (
        <div className="overlay" onMouseDown={() => setModal(null)}>
          <section
            className={`modal ${modal.kind === 'ssh' ? 'wide' : ''}`}
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
                onPoll={load}
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
                  if (saved.enabled) await api('/refresh', { source_id: saved.id });
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
      {detail && ctx && (
        <div className="drawer-overlay" onMouseDown={() => setDetail(null)}>
          <aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="drawer-header">
              <div>
                <span className="drawer-kind">
                  {detail.kind === 'job' ? t('drawer.job') : t('drawer.instance')}
                </span>
                <h2 id="detail-title">{detail.item.name}</h2>
                <Status state={detail.item.state} />
              </div>
              <button
                className="icon-button"
                aria-label={t('common.close')}
                onClick={() => setDetail(null)}
              >
                <X size={16} />
              </button>
            </header>
            {detail.kind === 'job' ? (
              <JobDetail job={detail.item} ctx={ctx} />
            ) : (
              <InstanceDetail
                item={detail.item}
                ctx={ctx}
                onProbe={async () => {
                  try {
                    await mutate(`/instances/${encodeURIComponent(detail.item.id)}/probe`, {});
                    const latest = await api<Dashboard>('/dashboard?demo=false');
                    const item = latest.instances.find((each) => each.id === detail.item.id);
                    if (item) setDetail({ kind: 'instance', item });
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
