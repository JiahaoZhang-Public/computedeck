import { useStableActions } from './useStableActions';
import {
  collectSource,
  finishCollections,
  testSource,
  setSourcePaused,
  useSourceInFlight,
} from './sourceActions';
import { dismissErrorRow } from './layers/focus';
import { CopyContext, createCopy } from './copy';
import { routeParams, setRouteParams } from './useRouteParam';
import { computeHealth } from './health';
import { useVisibleInterval } from './useVisibleInterval';
import { usePollCadence } from './data/cadence';
import { createLiveStore } from './data/store';
import type { LiveSnapshot } from './data/store';
import { changed, sincePath, tokenOf } from './data/poll';
import type { Unchanged } from './data/poll';
import { transitions } from './data/transitions';
import { LocaleGate } from './app/LocaleGate';
import { Frame } from './app/Frame';
import { lazyView } from './app/lazyView';
import { StatusLabel } from './ui/Status';
import { Time } from './ui/Time';
import { Toasts } from './layers/Toasts';
import type { Toast, ToastAction } from './layers/Toasts';
import { hasModalLayer } from './layers/stack';
import {
  openLayer,
  closeLayer,
  detailKeys,
  detailValues,
  formKeys as getFormKeys,
} from './layers/routes';
import type { Modal, Detail } from './app/Layers';
import { Routes } from './app/Routes';
import { Loading } from './app/LoadState';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
  rememberServerLocale,
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

const Layers = lazyView(async () => ({ default: (await import('./app/Layers')).Layers }));

const startPages = [...corePages, '__gallery', ...pagesOf(buildTimePlugins).map((page) => page.id)];

export default function App() {
  return <LocaleGate>{(language) => <Application initialLocale={language} />}</LocaleGate>;
}

function Application({ initialLocale }: { initialLocale: Locale }) {
  const remote = new URLSearchParams(window.location.search).get('remote') === '1';
  const [locale, setLocaleState] = useState(() => {
    setLocale(initialLocale);
    return initialLocale;
  });
  const hash = useHash();
  const group = readRoute(startPages, hash).group;
  const query = routeParams(hash).get('q') ?? '';
  const setQuery = (value: string) => setRouteParams({ q: value });
  const [demo, setDemo] = useState(
    () => new URLSearchParams(window.location.search).get('demo') === 'true',
  );
  const [live] = useState(createLiveStore);
  const {
    data: served,
    health,
    tools,
    nodes,
    error,
    needsToken,
    loading,
    announcement,
  } = useSyncExternalStore(live.subscribe, live.getSnapshot);
  // Example mode keeps dismissals on the page: nothing is sent, and a reload or leaving example
  // mode resets them (they are kept only for the mode they were made in).
  const [local, setLocal] = useState<{
    demo: boolean;
    muted: Record<string, Attention['muted']>;
  }>({ demo, muted: {} });
  const localMuted = useMemo(() => (local.demo === demo ? local.muted : {}), [local, demo]);
  const data = useMemo(() => {
    if (!served || !demo || !Object.keys(localMuted).length) return served;
    const attention = (served.attention ?? []).map((item) =>
      item.key in localMuted ? { ...item, muted: localMuted[item.key] } : item,
    );
    return {
      ...served,
      attention,
      attention_count: attention.filter((item) => !item.muted).length,
    };
  }, [served, demo, localMuted]);
  const cadence = usePollCadence();
  const publish = useCallback(
    (patch: Partial<LiveSnapshot>) => {
      const before = live.getSnapshot();
      const text = transitions(before, { ...before, ...patch }, demo);
      live.update({
        ...patch,
        ...(text ? { announcement: { id: before.announcement.id + 1, text } } : {}),
      });
    },
    [live, demo],
  );
  const [refreshing, setRefreshing] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [sshData, setSSHData] = useState<SSHConfig | null>(null);
  const [sourcePreset, setSourcePreset] = useState<SourcePreset | undefined>();
  const params = routeParams(hash);
  const formKeys = getFormKeys(params);
  const sourceId = params.get('repair') || params.get('source');
  const editId = hash.split('?')[0] === '#/toolbox' ? null : params.get('edit');
  const add = params.get('add');
  const editedSource = data?.sources.find((item) => item.id === editId);
  const editedInstance = data?.instances.find((item) => item.id === editId);
  // A source's pane opens once sources are known. Opened on a cold link before they load, it
  // said "not found" and dropped focus when the source's own heading replaced that line.
  const modal: Modal = sourceId
    ? data
      ? { kind: 'diagnosis', sourceId, reading: !params.has('repair') }
      : null
    : params.get('section') === 'ssh' && sshData
      ? { kind: 'ssh', data: sshData }
      : editId && editedSource
        ? { kind: 'source', source: editedSource }
        : editId && editedInstance
          ? { kind: 'instance', item: editedInstance }
          : editId && data
            ? { kind: 'missing' }
            : add === 'instance' || add === 'manual'
              ? { kind: 'instance' }
              : add
                ? {
                    kind: 'source',
                    preset: { ...sourcePreset, ...(add !== 'source' ? { driver: add } : {}) },
                  }
                : null;
  const setModal = (next: Modal) => {
    if (!next) {
      closeLayer([...formKeys, ...(params.has('source') ? ['source'] : [])]);
      return;
    }
    if (next.kind === 'ssh') setSSHData(next.data);
    if (next.kind === 'source') setSourcePreset(next.preset);
    openLayer(
      {
        add:
          next.kind === 'instance' && !next.item
            ? 'instance'
            : next.kind === 'source' && !next.source
              ? (next.preset?.driver ?? 'source')
              : null,
        edit:
          next.kind === 'instance'
            ? (next.item?.id ?? null)
            : next.kind === 'source'
              ? (next.source?.id ?? null)
              : null,
        ...detailValues(),
        repair: next.kind === 'diagnosis' && !next.reading ? next.sourceId : null,
        source: next.kind === 'diagnosis' && next.reading ? next.sourceId : null,
        section:
          next.kind === 'ssh'
            ? 'ssh'
            : params.get('section') === 'ssh'
              ? null
              : params.get('section'),
        step:
          next.kind === 'source'
            ? next.source || next.preset?.driver
              ? '2'
              : '1'
            : next.kind === 'instance'
              ? '1'
              : null,
      },
      !!modal,
    );
  };
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
    hash.split('?')[0] === '#/__gallery'
      ? null
      : (detailKeys
          .filter((key) => key !== 'source')
          .map((key) => params.get(key))
          .find(Boolean) ?? null);
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
      openLayer(
        {
          ...detailValues(),
          job: next?.kind === 'job' && !failure ? next.item.id : null,
          failure: next?.kind === 'job' && failure ? next.item.id : null,
          instance: next?.kind === 'instance' ? next.item.id : null,
          array: next?.kind === 'array' ? next.item.id : null,
        },
        !next,
      );
    },
    [data?.recent_failures],
  );
  const closeDetail = useCallback(() => {
    closeLayer([...detailKeys]);
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [noticeErrors, setNoticeErrors] = useState<(Toast & { at: string })[]>([]);
  const toastId = useRef(0);
  const dismissToast = useCallback(
    (id?: number) =>
      setToasts((items) => (id === undefined ? [] : items.filter((item) => item.id !== id))),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
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
  const auxTokens = useRef<Record<string, string | undefined>>({});
  const lastAuxLoad = useRef(-Infinity);
  const activePoll = useRef<{ startedAt: number; promise: Promise<void> } | null>(null);
  const [followUntil, setFollowUntil] = useState(0);
  const followSources = useRef<string[] | null>(null);
  const latestCollecting = useRef<string[]>([]);
  const followLoaded = useRef(false);
  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok', action?: ToastAction) => {
    const item = { id: ++toastId.current, text, tone, action, at: new Date().toISOString() };
    setToasts((items) => [...items, item].slice(-3));
    if (tone === 'error')
      setNoticeErrors((items) =>
        items.some((row) => row.text === text) ? items : [...items, item],
      );
  }, []);
  const sshOpen = params.get('section') === 'ssh';
  useEffect(() => {
    if (!sshOpen || sshData || !data) return;
    let active = true;
    const request =
      remote || demo
        ? Promise.resolve({
            config: clientSSHConfig(data.instances),
            path: t('ssh.downloadPath'),
            installed: false,
          })
        : api<SSHConfig>('/ssh/config');
    void request.then(
      (data) => {
        if (active) setSSHData(data);
      },
      (reason) => {
        if (active) notify(errorText(reason, 'error.sshConfig'), 'error');
      },
    );
    return () => {
      active = false;
    };
  }, [sshOpen, sshData, demo, remote, data, notify]);
  const serverName = demo
    ? t('where.local')
    : health?.server_name || health?.server_host || t('where.server');

  const localeChange = useRef(0);
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  const changeLocale = useCallback(
    (next: Locale) => {
      const request = ++localeChange.current;
      setPendingLocale(next);
      void loadLocale(next)
        .then(() => {
          if (request !== localeChange.current) return;
          setLocale(next);
          storeLocale(next);
          setLocaleState(next);
        })
        .catch(() => {
          if (request === localeChange.current) notify(t('error.locale'), 'error');
        })
        .finally(() => {
          if (request === localeChange.current) setPendingLocale(null);
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
        rememberServerLocale(settings.language);
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
        api<Dashboard | Unchanged>(
          `/dashboard?demo=${demo}${dashboardToken.current ? `&since=${dashboardToken.current}` : ''}`,
        ),
        // Health also carries plugin state; a failure here must not hide the dashboard.
        dashboardOnly
          ? null
          : api<Health | Unchanged>(sincePath('/health', auxTokens.current.health)).catch(
              () => null,
            ),
        dashboardOnly
          ? null
          : api<Tool[] | Unchanged>(sincePath('/toolbox', auxTokens.current.toolbox)).catch(
              () => null,
            ),
        dashboardOnly
          ? null
          : api<CollectionNode[] | Unchanged>(
              sincePath(`/nodes?demo=${demo}`, auxTokens.current.nodes),
            ).catch(() => null),
      ])
        .then(([next, status, toolbox, machines]) => {
          if (requestId !== loadId.current) return;
          followLoaded.current = true;
          const patch: Partial<LiveSnapshot> = { error: null, needsToken: false, loading: false };
          if (changed(next)) {
            dashboardToken.current = next.token;
            latestCollecting.current = next.collecting ?? [];
            finishCollections(latestCollecting.current);
            patch.data = next;
          }
          if (!dashboardOnly) {
            lastAuxLoad.current = requestedAt;
            if (!status || changed(status)) {
              patch.health = status;
              auxTokens.current.health = status ? tokenOf(status) : undefined;
            }
          }
          if (changed(toolbox)) {
            auxTokens.current.toolbox = tokenOf(toolbox);
            patch.tools = toolbox;
          }
          if (changed(machines)) {
            auxTokens.current.nodes = tokenOf(machines);
            patch.nodes = machines;
          }
          publish(patch);
          // Driver descriptions do not change while the service runs; fetch them once.
          if (!document.hidden && !driversLoaded.current) {
            driversLoaded.current = true;
            api<DriverInfo[]>('/drivers')
              .then(setDrivers)
              .catch(() => {
                driversLoaded.current = false;
              });
          }
        })
        .catch((reason) => {
          if (requestId !== loadId.current) return;
          publish({
            needsToken: reason instanceof ApiError && reason.status === 401,
            error: errorText(reason, 'error.service'),
            loading: false,
          });
        });
    },
    [demo, publish],
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
    const pending = load(!!followUntil && startedAt - lastAuxLoad.current < cadence);
    activePoll.current = { startedAt, promise: pending };
    return pending.finally(() => {
      if (activePoll.current?.promise === pending) activePoll.current = null;
    });
  }, [load, followUntil, cadence]);
  useVisibleInterval(poll, followUntil ? 1000 : cadence);
  const followCollection = useCallback((sourceIds: string[] | null = null) => {
    followSources.current = sourceIds;
    followLoaded.current = false;
    // A poll started before this action cannot tell us whether its collection finished.
    loadId.current += 1;
    activePoll.current = null;
    setFollowUntil(Date.now() + 60000);
  }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || hasModalLayer()) return;
      if (event.key === 'Escape') setSidebarOpen(false);
      if ((event.metaKey || event.ctrlKey) && event.key === 'k' && searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

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
    live.update({ tools: live.getSnapshot().tools.map((tool) => (tool.id === id ? saved : tool)) });
    return saved;
  }
  const blockedInDemo = () => {
    // The refusal carries its own way out.
    if (demo)
      notify(t('toast.demoReadOnly'), 'ok', { label: t('banner.demoOff'), run: toggleDemo });
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
  const sourceInFlight = useSourceInFlight();
  async function pauseSource(source: Source) {
    if (blockedInDemo()) return;
    try {
      await setSourcePaused(source, source.enabled);
      await load();
      notify(t(source.enabled ? 'sources.paused' : 'sources.resumed'), 'ok', {
        label: t('layer.undo'),
        undo: true,
        run: () => {
          void setSourcePaused(source, !source.enabled)
            .then(() => load())
            .catch((reason) => notify(errorText(reason, 'error.service'), 'error'));
        },
      });
    } catch (reason) {
      notify(errorText(reason, 'error.service'), 'error');
    }
  }
  async function collect(source: Source) {
    try {
      if (
        blockedInDemo() ||
        data?.collecting?.includes(source.id) ||
        !(await collectSource(source))
      )
        return;
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
  const copy = useCallback<import('./copy').Copy>(
    (text, options) => createCopy(demo, notify)(text, options),
    [demo, notify],
  );
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
    auxTokens.current = {};
    lastAuxLoad.current = -Infinity;
    setFollowUntil(0);
    live.update({
      data: null,
      nodes: [],
      loading: true,
      announcement: { id: 0, text: '' },
    });
    const next = !demo;
    // Leaving or entering example mode forgets dismissals made on the page.
    setLocal({ demo: next, muted: {} });
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('demo', 'true');
    else url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
    setDemo(next);
    setSSHData(null);
    setToasts([]);
    setNoticeErrors([]);
    setRouteParams(Object.fromEntries([...formKeys, ...detailKeys].map((key) => [key, null])));
    setHealthOpen(false);
    setRouteParams({ group: null, provider: null, q: null });
  };

  const groups = useMemo(
    () => (data ? groupsOf(data) : []),
    // Labels are recomputed with the data; the locale does not affect them.
    [data],
  );
  const attention = data?.attention ?? [];
  // A source opens as the pane beside the list (a sheet on phones), like a job.
  const diagnose = (source: Source) =>
    setModal({ kind: 'diagnosis', sourceId: source.id, reading: true });
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
  /** Dismiss (until it changes), snooze or restore an attention item. */
  const muteAttention = async (
    item: Attention,
    action: 'acknowledge' | 'snooze' | 'clear',
    until?: '1h' | 'tomorrow',
  ) => {
    if (demo) {
      const at = new Date();
      const end = new Date(at);
      if (until === '1h') end.setHours(end.getHours() + 1);
      else end.setHours(24, 0, 0, 0);
      setLocal((current) => ({
        demo: true,
        muted: {
          ...(current.demo ? current.muted : {}),
          [item.key]:
            action === 'clear'
              ? null
              : {
                  state: action === 'snooze' ? 'snoozed' : 'acknowledged',
                  at: at.toISOString(),
                  until: action === 'snooze' ? end.toISOString() : null,
                },
        },
      }));
      return;
    }
    try {
      await api(
        `/attention/${encodeURIComponent(item.key)}`,
        { action, until, ...(action === 'clear' ? {} : { fingerprint: item.fingerprint }) },
        'PUT',
      );
    } finally {
      await load();
    }
  };
  const healthState = computeHealth(data, health, error, needsToken, demo, nodes);
  const plugin: PluginProps = { request: api, demo, remote, locale, page, health, navigate };
  const activePluginPage = pluginPages.find((item) => item.id === page);

  const actions = useStableActions<import('./pages/shared').CtxActions>({
    setGroup,
    setQuery,
    openAttention,
    muteAttention,
    diagnose,
    changeLocale,
    navigate,
    reload: load,
    updateTool,
    configure,
    collect,
    collectSource: collect,
    testSource: (source) => {
      if (blockedInDemo() || data?.collecting?.includes(source.id)) return Promise.resolve();
      return testSource(source.id);
    },
    pauseSource,
    addInstance,
    showSSH,
    openJob: (item) => setDetail({ kind: 'job', item }),
    openEvent: (event) => {
      setSelectedEvent({ demo, event });
      openLayer(detailValues({ event: String(event.id) }));
    },
    openArray: (item) => setDetail({ kind: 'array', item }),
    openInstance: (item) => setDetail({ kind: 'instance', item }),
    copy,
    notify,
    backup,
    toggleDemo,
  });
  const context: Omit<Ctx, 'data'> = {
    ...actions,
    actions,
    groups,
    demo,
    remote,
    serverName,
    busy,
    group,
    query,
    searchRef,
    attention,
    health,
    locale,
    pendingLocale,
    plugin,
    webPlugins: plugins,
    drivers,
    nodes,
    tools,
    sourceInFlight,
  };
  const ctx: Ctx | null = data ? { ...context, data } : null;

  return (
    <CopyContext value={copy}>
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
            {noticeErrors.length > 0 && (
              <section className="layer-errors" aria-label={t('layer.errors')}>
                {noticeErrors.map((item) => (
                  <div key={item.id}>
                    <StatusLabel kind="error" label={item.text} />
                    <Time value={item.at} />
                    <button
                      className="button"
                      onClick={(event) =>
                        dismissErrorRow(event.currentTarget, () =>
                          setNoticeErrors((items) => items.filter((row) => row.id !== item.id)),
                        )
                      }
                    >
                      {t('common.dismiss')}
                    </button>
                  </div>
                ))}
              </section>
            )}
            <PageBoundary page={page}>
              {needsToken ? (
                <TokenGate
                  where={where({ remote, serverName })}
                  rejected={sessionRejected()}
                  onSave={async (value) => {
                    const session = await api<{ token: string }>('/session', { token: value });
                    setToken(session.token);
                    live.update({ loading: true });
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
        <Toasts items={toasts} dismiss={dismissToast} announcement={announcement} />
        {(modal || detailId || healthOpen) && (
          <Suspense fallback={null}>
            <Layers
              ctx={{ ...context, data }}
              modal={modal}
              setModal={setModal}
              detail={detail}
              detailId={detailId}
              closeDetail={closeDetail}
              eventId={eventId}
              eventLoad={eventLoad}
              healthOpen={healthOpen}
              setHealthOpen={setHealthOpen}
              healthState={healthState}
              needsToken={needsToken}
              refreshing={refreshing}
              refresh={refresh}
              mutate={mutate}
              followCollection={followCollection}
            />
          </Suspense>
        )}
      </div>
    </CopyContext>
  );
}
