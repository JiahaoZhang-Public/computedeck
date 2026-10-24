import type { ReactNode } from 'react';
import {
  Activity,
  Cable,
  Cloud,
  Compass,
  Gauge,
  History,
  LayoutDashboard,
  Menu,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Settings2,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { dateTime, partialCount } from '../domain';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { routeHash } from '../routes';
import type { CorePage, Page } from '../routes';
import { labelText, pagesOf } from '../plugins';
import { BrandMark } from '../ui';
import { enabledToolPages } from '../tools';
import type { Ctx } from '../pages/shared';
import type { Dashboard } from '../types';
import type { computeHealth } from '../health';

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

export function Frame({
  ctx,
  data,
  page,
  sidebarOpen,
  setSidebarOpen,
  healthOpen,
  setHealthOpen,
  healthState,
  error,
  needsToken,
  refreshing,
  refresh,
  children,
}: {
  ctx: Omit<Ctx, 'data'>;
  data: Dashboard | null;
  page: Page;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  healthOpen: boolean;
  setHealthOpen: (open: boolean) => void;
  healthState: ReturnType<typeof computeHealth>;
  error: string | null;
  needsToken: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  children: ReactNode;
}) {
  const {
    remote,
    demo,
    serverName,
    locale,
    configure,
    showSSH,
    addInstance,
    toggleDemo,
    reload: load,
    webPlugins: plugins,
    plugin,
    tools,
  } = ctx;
  const pluginPages = pagesOf(plugins);
  const activePluginPage = pluginPages.find((item) => item.id === page);
  const toolNav = enabledToolPages(tools);
  const problems = data?.attention_count ?? data?.attention?.length ?? 0;
  const jobCount = data ? partialCount(data.summary.jobs.total, data.summary.jobs.known) : 0;
  const isDataPage = dataPages.includes(page);
  const healthDescription =
    healthState.label === healthState.age
      ? healthState.label
      : t('health.withAge', { label: healthState.label, age: healthState.age });
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
    : page === '__gallery'
      ? t('gallery.title')
      : t(pageTitles[page as CorePage] ?? 'nav.overview');

  return (
    <>
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
        {children}
      </div>
    </>
  );
}
