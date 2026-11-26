import { StatusShape } from '../ui/Status';
import { useEffect, useState } from 'react';
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
  Monitor,
  Moon,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Settings2,
  Sun,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useClock } from '../ui/clock';
import { relativeTime } from '../format';
import { dateTime } from '../domain';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { routeHash } from '../routes';
import type { CorePage, Page } from '../routes';
import { labelText, pagesOf } from '../plugins';
import { BrandMark } from '../ui';
import { readTheme, saveTheme, THEME_EVENT } from '../theme/preferences';
import type { Theme } from '../theme/preferences';
import { enabledToolPages } from '../tools';
import type { Ctx } from '../pages/shared';
import type { Dashboard } from '../types';
import type { computeHealth } from '../health';

// Groups are separated by space, not labelled; each item is a line icon and its label.
const navGroups: {
  items: { id: CorePage; label: MessageKey; icon: typeof Server }[];
}[] = [
  {
    items: [
      { id: 'overview', label: 'nav.overview', icon: LayoutDashboard },
      { id: 'plan', label: 'nav.plan', icon: Compass },
    ],
  },
  {
    items: [
      { id: 'jobs', label: 'nav.jobs', icon: Activity },
      { id: 'activity', label: 'nav.activity', icon: History },
      { id: 'resources', label: 'nav.clusters', icon: Server },
      { id: 'cloud', label: 'nav.cloud', icon: Cloud },
      { id: 'usage', label: 'nav.usage', icon: Gauge },
    ],
  },
  {
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
  const isDataPage = dataPages.includes(page);
  const collecting = !!data?.collecting?.length && !needsToken;
  // Nothing connected yet: the page itself says so, and there is nothing to refresh or check.
  const unconfigured =
    !demo && !error && !needsToken && !!data && !data.sources.length && !data.instances.length;
  // Example mode is named once, beside the title; the control that leaves it is its own cross.
  const exampleMode = demo && (
    <>
      <span>{t('banner.demo')}</span>
      <button
        className="icon-button"
        aria-label={t('banner.demoOff')}
        title={t('banner.demoOff')}
        onClick={toggleDemo}
      >
        <X size={14} />
      </button>
    </>
  );
  const serviceText = needsToken
    ? t('token.title')
    : error
      ? remote
        ? t('service.remoteDown', { server: serverName })
        : t('service.localDown')
      : data
        ? remote
          ? t('service.remoteUp', { server: serverName })
          : t('service.localUp')
        : t('service.connecting');
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

  // Each page names itself in the tab and in history.
  useEffect(() => {
    document.title = `${title} · ComputeDeck`;
  }, [title]);
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
          {/* Only a remote service needs naming; local is the default. */}
          {remote && (
            <span className="brand-mode" title={serverName}>
              {serverName}
            </span>
          )}
        </div>
        <nav aria-label={t('nav.main')}>
          {navGroups.map((navGroup, index) => (
            <div className="nav-group" key={index}>
              {navGroup.items.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={routeHash(id)}
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t(label)}</span>
                  {id === 'overview' && problems > 0 && (
                    <b className="badge" title={t('nav.problems', { count: problems })}>
                      {problems}
                    </b>
                  )}
                </a>
              ))}
            </div>
          ))}
          {toolNav.length + pluginPages.length > 0 && (
            <div className="nav-group">
              {toolNav.map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  href={routeHash(id)}
                  className={`nav-item ${page === id ? 'active' : ''}`}
                  aria-current={page === id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
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
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
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
            <Settings2 size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>{t('nav.settings')}</span>
          </a>
          <label className="demo-toggle">
            <span>{t('nav.demo')}</span>
            <input type="checkbox" role="switch" checked={demo} onChange={toggleDemo} />
            <i aria-hidden="true" />
          </label>
          <ThemeSwitch />
          {/* Which service this page shows, and whether it answers. */}
          <div className="service-state">
            <span className={`dot ${error ? 'red' : data ? 'green' : ''}`} aria-hidden="true" />
            {serviceText}
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
          {demo && <div className="example-mode demo-banner">{exampleMode}</div>}
          <div className="topbar-actions">
            <div className="health-status">
              <HealthPill
                data={data}
                healthState={healthState}
                needsToken={needsToken}
                healthOpen={healthOpen}
                setHealthOpen={setHealthOpen}
              />
            </div>
            {/* Example mode keeps the one action that says how to connect; it refuses politely. */}
            {(!demo || page === 'sources') && pageActions[page]}
            {isDataPage && !unconfigured && (
              <>
                <button
                  className="button"
                  onClick={() => void refresh()}
                  disabled={refreshing || needsToken}
                  title={
                    collecting
                      ? t('health.collecting', { count: data!.collecting!.length })
                      : t('topbar.refreshHint')
                  }
                  aria-label={t('topbar.refresh')}
                >
                  {/* Collection in progress is the button's own busy state: a turning icon and
                      its title. Not aria-busy, which marks a region whose content is changing. */}
                  <RefreshCw
                    size={14}
                    className={refreshing || data?.refreshing || collecting ? 'spin' : ''}
                  />
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
        {/* A phone's top bar has no room for it: the same label and cross on their own line. */}
        {demo && <div className="example-mode example-mode-line">{exampleMode}</div>}
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
        {(!demo || __TEST_PLUGIN_SLOTS__) &&
          plugins
            .filter((item) => item.banner)
            .map((item) => {
              const Banner = item.banner!;
              return (
                <div className="plugin-slot" data-plugin={item.id} key={item.id}>
                  <Banner {...plugin} />
                </div>
              );
            })}
        {children}
      </div>
    </>
  );
}

const themes: [Theme, typeof Sun][] = [
  ['system', Monitor],
  ['light', Sun],
  ['dark', Moon],
];

/** Light, dark or the system's choice: three icons, one pressed. */
function ThemeSwitch() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  return (
    <div className="theme-switch" role="group" aria-label={t('settings.theme')}>
      {themes.map(([value, Icon]) => (
        <button
          key={value}
          aria-pressed={theme === value}
          aria-label={t(`settings.theme.${value}`)}
          title={t(`settings.theme.${value}`)}
          onClick={() => saveTheme(value)}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function HealthPill({
  data,
  healthState,
  needsToken,
  healthOpen,
  setHealthOpen,
}: {
  data: Dashboard | null;
  healthState: ReturnType<typeof computeHealth>;
  needsToken: boolean;
  healthOpen: boolean;
  setHealthOpen: (open: boolean) => void;
}) {
  const now = useClock();
  const age = !needsToken && data?.as_of ? relativeTime(data.as_of, now) : healthState.age;
  const healthDescription =
    healthState.label === age
      ? healthState.label
      : t('health.withAge', { label: healthState.label, age });
  return (
    <button
      className={`health-pill health-${healthState.quiet ? 'quiet' : healthState.level}`}
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
      {/* Items needing attention: a status mark and their number. None: only the freshness. */}
      {healthState.quiet ? (
        <span className="health-fresh">{age}</span>
      ) : healthState.count > 0 ? (
        <>
          <StatusShape kind={healthState.level} />
          <span className="health-count">{healthState.count}</span>
        </>
      ) : (
        <>
          <StatusShape kind={healthState.level} />
          <span className="health-label">{healthDescription}</span>
          <span className="health-age" aria-hidden="true">
            {age}
          </span>
        </>
      )}
    </button>
  );
}
