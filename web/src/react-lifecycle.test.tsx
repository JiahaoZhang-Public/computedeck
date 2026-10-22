// @vitest-environment jsdom
import { serverDashboard, serverDemo } from './test-server';
import { act, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Puzzle } from 'lucide-react';
import App from './App';
import { HealthPanel } from './HealthPanel';
import { SourceDiagnosis } from './SourceDiagnosis';
import { computeHealth } from './health';
import { api } from './api';
import { ApiError, setLocale, t } from './i18n';
import { registerWebPlugin } from './plugins';
import TrendChart from './TrendChart';
import { ChatPage } from './pages/Chat';
import { JobsPage } from './pages/Jobs';
import { dateTime, relativeTime } from './domain';
import { driverInfo } from './drivers';
import { groupsOf } from './groups';
import { HistoryPanel } from './pages/HistoryPanel';
import { UsagePage } from './pages/Usage';
import { NotifyPage } from './pages/Notify';
import { ActivityPanel } from './pages/Activity';
import { SourcesPage } from './pages/Sources';
import { EMPTY_RULE } from './notify';
import { changeFieldLabel, OUTCOME_LABELS } from './events';
import type { Ctx } from './pages/shared';
import type { Dashboard, DeckEvent, HistoryPoint, Tool } from './types';

vi.mock('./api', () => ({ api: vi.fn(), upload: vi.fn(), download: vi.fn() }));
const request = vi.mocked(api);
const now = new Date('2026-10-13T12:00:00Z');
let container: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function render(node: ReactNode) {
  await act(async () => root.render(<StrictMode>{node}</StrictMode>));
}

async function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

function sample(hoursAgo: number): HistoryPoint {
  return {
    at: new Date(now.getTime() - hoursAgo * 3600000).toISOString(),
    allocated_gpus: 4,
    gpu_utilization: 50,
    coverage_count: 1,
  };
}

function dashboard(name: string): Dashboard {
  return serverDashboard({
    mode: 'live',
    sources: [
      {
        id: 'cluster-a',
        name,
        driver: 'slurm',
        kind: 'cluster',
        cluster_id: 'cluster-a',
        username: 'alice',
        ssh_alias: 'cluster-a',
        credential: '',
        enabled: true,
        status: 'ready',
        last_success: null,
        last_attempt: null,
        error: null,
        interval_minutes: 10,
        capabilities: [],
        qos: [],
      },
    ],
    jobs: [],
    instances: [],
    nodes: [],
    history: [],
    updated_at: null,
    refreshing: false,
  });
}

function context(id: string, enabled = true): Ctx {
  return {
    tools: [{ id, enabled }],
    demo: false,
    notify: vi.fn(),
    copy: vi.fn(),
  } as unknown as Ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  HTMLElement.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  setLocale('en');
  request.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard lifecycle', () => {
  it('uses the server Jobs count and opens a named unmeasured machine', async () => {
    const data = serverDemo();
    data.summary.jobs.total = null;
    data.summary.jobs.known = 2;
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    expect(container.querySelector('a[href="#/jobs"] .badge')?.textContent).toBe('≥ 2');
    const more = [...container.querySelectorAll<HTMLButtonElement>('.stat-hint button')].find(
      (button) =>
        button.textContent === t('summary.more', { count: data.summary.unmeasured.length - 2 }),
    );
    expect(more).toBeDefined();
    more!.focus();
    await act(async () => more!.click());
    const missing = [...container.querySelectorAll<HTMLButtonElement>('.stat-hint button')].find(
      (button) => button.textContent?.includes('build-box'),
    );
    expect(missing).toBeDefined();
    await act(async () => missing!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('build-box');
  });

  it.each(['en', 'zh-CN'] as const)(
    'limits each unmeasured hint to two links until expanded in %s',
    async (locale) => {
      const data = serverDemo();
      const missing = ['first-login', 'second-login', 'third-login', 'fourth-login'].map(
        (name) => ({
          subject: { kind: 'source' as const, id: name, name },
          reason: { code: 'summary_source_stale' },
        }),
      );
      data.summary.unmeasured = missing;
      data.summary.queued_unmeasured = missing;
      data.summary.jobs.missing_source_ids = missing.map((item) => item.subject.id);
      data.summary.requested = null;
      data.summary.running = null;
      setLocale(locale);
      request.mockImplementation(async (path) => {
        if (path.startsWith('/dashboard')) return data;
        if (path === '/settings') return { language: locale };
        if (path === '/health') return null;
        return [];
      });
      await render(<App />);
      const hints = [...container.querySelectorAll<HTMLElement>('.stat-hint')].slice(0, 3);
      for (const hint of hints) {
        expect(hint.textContent).toContain('first-login');
        expect(hint.textContent).toContain('second-login');
        expect(hint.textContent).not.toContain('third-login');
        expect(hint.textContent).not.toContain('fourth-login');
        for (const item of hint.querySelectorAll('.sub')) {
          expect(item.textContent?.startsWith(' · ')).toBe(false);
        }
        const more = [...hint.querySelectorAll('button')].find(
          (button) => button.textContent === t('summary.more', { count: 2 }),
        );
        expect(more?.getAttribute('aria-expanded')).toBe('false');
        expect(more?.textContent).toBe(t('summary.more', { count: 2 }));
        more!.focus();
        await act(async () => more!.click());
        expect(hint.textContent).toContain('third-login');
        expect(hint.textContent).toContain('fourth-login');
        expect(hint.contains(more!)).toBe(true);
        expect(more?.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(more);
        expect(more?.textContent).toBe(t('summary.fewer'));
      }
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'matches Jobs tab rows and counts for plugin state aliases in %s',
    async (locale) => {
      setLocale(locale);
      request.mockResolvedValue([]);
      const data = serverDemo();
      const source = data.sources.find((item) => item.kind === 'cluster')!;
      source.enabled = true;
      source.status = 'ready';
      source.error = null;
      source.stale = false;
      source.last_success = now.toISOString();
      source.capabilities = ['jobs'];
      data.sources = [source];
      data.jobs = ['R', 'CF', 'CG', 'PD', 'Q', 'PEND', 'QUEUED', 'COMPLETED'].map((state) => ({
        ...data.jobs[0],
        id: `cluster-a:${state}`,
        name: `train-${state}`,
        source_id: source.id,
        cluster_id: source.cluster_id,
        state,
      }));
      data.instances = [];
      data.nodes = [];
      const ctx = {
        data: serverDashboard(data),
        groups: groupsOf(data),
        group: 'all',
        query: '',
        configure: vi.fn(),
        openJob: vi.fn(),
        setGroup: vi.fn(),
      } as unknown as Ctx;
      await render(<JobsPage ctx={ctx} />);
      for (const [index, states] of [
        [2, ['R', 'CF', 'CG']],
        [3, ['PD', 'Q', 'PEND', 'QUEUED']],
      ] as const) {
        await click(`[role="tab"]:nth-child(${index})`);
        expect(
          container.querySelector('[role="tab"][aria-selected="true"] span')?.textContent,
        ).toBe(String(states.length));
        const rows = [...container.querySelectorAll('tr.clickable')];
        expect(rows).toHaveLength(states.length);
        for (const state of states)
          expect(rows.some((row) => row.textContent?.includes(`train-${state}`))).toBe(true);
      }
      ctx.query = 'train-Q';
      await render(<JobsPage ctx={ctx} />);
      expect(container.querySelector('[role="tab"][aria-selected="true"] span')?.textContent).toBe(
        '2',
      );
      expect(container.querySelectorAll('tr.clickable')).toHaveLength(2);
    },
  );

  it('ignores a live response that finishes after switching to example data', async () => {
    const live = deferred<Dashboard>();
    const demo = deferred<Dashboard>();
    request.mockImplementation(async (path) => {
      if (path === '/dashboard?demo=false') return live.promise;
      if (path === '/dashboard?demo=true') return demo.promise;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    await click('[role="switch"]');
    await act(async () => demo.resolve(dashboard('Example cluster')));
    expect(container.textContent).toContain('Example cluster');
    await act(async () => live.resolve(dashboard('Live cluster')));
    expect(container.textContent).not.toContain('Live cluster');
    expect(container.textContent).toContain('Example cluster');
  });

  it('resolves a plugin deep link after registration and hides it when disabled', async () => {
    window.history.replaceState(null, '', '/#/example-tool');
    let tools = [{ id: 'example-tool', enabled: true }] as Tool[];
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return dashboard('Cluster A');
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      if (path === '/toolbox') return tools;
      return [];
    });
    await render(<App />);
    expect(container.textContent).not.toContain('Example plugin page');
    await act(async () =>
      registerWebPlugin({
        id: 'example-tool',
        requires: 'example-tool',
        pages: [
          {
            id: 'example-tool',
            label: 'Example tool',
            icon: Puzzle,
            render: () => <p>Example plugin page</p>,
          },
        ],
      }),
    );
    expect(container.textContent).toContain('Example plugin page');
    tools = [{ id: 'example-tool', enabled: false }] as Tool[];
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(container.textContent).not.toContain('Example plugin page');
    expect(container.querySelector('h1')?.textContent).toBe('Overview');
    await act(async () => {
      window.history.replaceState(null, '', '/#/jobs');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('h1')?.textContent).toBe('Jobs');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(document.activeElement).toBe(container.querySelector('.search input'));
  });
});

describe('history lifecycle', () => {
  function historyResult(points: HistoryPoint[]) {
    return {
      points,
      rollups: {
        start: new Date(now.getTime() - 168 * 3600000).toISOString(),
        end: now.toISOString(),
        buckets: [],
      },
    };
  }
  function usageContext(demo = false): Ctx {
    const data = dashboard('Cluster A');
    return { data, groups: groupsOf(data), demo, locale: 'en' } as Ctx;
  }
  it('ignores a previous range response and resets errors when selecting another range', async () => {
    const day = deferred<ReturnType<typeof historyResult>>();
    const week = deferred<ReturnType<typeof historyResult>>();
    request.mockImplementation((path) => (path.includes('hours=24') ? day.promise : week.promise));
    await render(<UsagePage ctx={usageContext()} />);
    await click('[role="tab"]:nth-child(2)');
    await act(async () => week.resolve(historyResult([sample(2), sample(3)])));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
    await act(async () => day.reject(new Error('Old request failed')));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
    await click('[role="tab"]:nth-child(1)');
    expect(container.textContent).toContain(t('chart.failed'));
    await click('[role="tab"]:nth-child(2)');
    expect(container.textContent).not.toContain(t('chart.failed'));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
  });

  it('does not display history from the previous demo mode while the new range loads', async () => {
    const demo = deferred<ReturnType<typeof historyResult>>();
    request.mockImplementation(async (path) =>
      path.includes('demo=true') ? demo.promise : historyResult([sample(2)]),
    );
    await render(<UsagePage ctx={usageContext()} />);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await click('[role="tab"]:nth-child(2)');
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await click('[role="tab"]:nth-child(2)');
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await render(<UsagePage ctx={usageContext(true)} />);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(0);
    expect(container.textContent).toContain(t('chart.loading'));
    await act(async () => demo.resolve(historyResult([sample(3), sample(4)])));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
  });

  it('presents supplied points, empty text and note without fetching or range controls', async () => {
    await render(
      <HistoryPanel points={[]} hours={24} empty={t('chart.loading')} note={t('usage.demo')} />,
    );
    expect(container.querySelector('.chart-empty')?.textContent).toBe(t('chart.loading'));
    expect(container.textContent).toContain(t('usage.demo'));
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    await render(<HistoryPanel points={[sample(2)]} hours={24} />);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
  });

  it('advances the time window without new data and stops its timer on unmount', async () => {
    await render(<TrendChart history={[sample(23.999)]} />);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(0);
    await render(null);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('tool lifecycle', () => {
  it('keeps slow chat replies and deduplicates overlapping polls', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    let pending = first;
    request.mockImplementation(async (path) =>
      path === '/plugins/chat' ? { channels: [], max_file_mb: 25 } : pending.promise,
    );
    await render(<ChatPage ctx={context('chat')} />);
    pending = second;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    const message = {
      id: 5,
      channel: 'general',
      at: now.toISOString(),
      author: 'Alice',
      body: 'First reply',
      attachment: null,
    };
    await act(async () => first.resolve([message]));
    expect(container.querySelectorAll('.chat-message')).toHaveLength(1);
    await act(async () => second.resolve([message, { ...message, id: 6, body: 'Second reply' }]));
    expect(container.querySelectorAll('.chat-message')).toHaveLength(2);
    expect(container.textContent).toContain('Second reply');
  });

  it('reports a failing first Chat load after mount or channel change', async () => {
    request.mockImplementation(async (path) => {
      if (path === '/plugins/chat')
        return {
          channels: [
            { id: 'general', label: 'General', kind: 'general' },
            { id: 'research', label: 'Research', kind: 'group' },
          ],
          max_file_mb: 25,
        };
      throw new Error(
        path.includes('channel=research') ? 'Research unavailable' : 'General unavailable',
      );
    });
    await render(<ChatPage ctx={context('chat')} />);
    expect(container.querySelector('.red-text')?.textContent).toContain('General unavailable');
    await click('.chat-channels button:nth-child(2)');
    expect(container.querySelector('.red-text')?.textContent).toContain('Research unavailable');
    expect(container.textContent).not.toContain('General unavailable');
  });

  it('keeps timed, visibility and focus Chat failures silent after the first load', async () => {
    let failing = false;
    request.mockImplementation(async (path) => {
      if (path === '/plugins/chat') return { channels: [], max_file_mb: 25 };
      if (failing) throw new Error('Temporary tunnel failure');
      return [];
    });
    await render(<ChatPage ctx={context('chat')} />);
    failing = true;
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.red-text')).toBeNull();
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.red-text')).toBeNull();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).toHaveBeenCalledTimes(3);
    expect(container.querySelector('.red-text')).toBeNull();
    failing = false;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(request).toHaveBeenCalledTimes(4);
    expect(container.querySelector('.red-text')).toBeNull();
  });

  it('ignores old chat replies after changing channels and resets the cursor on re-enable', async () => {
    const general = deferred<unknown[]>();
    request.mockImplementation(async (path) => {
      if (path === '/plugins/chat')
        return {
          channels: [
            { id: 'general', label: 'General', kind: 'general' },
            { id: 'research', label: 'Research', kind: 'group' },
          ],
          max_file_mb: 25,
        };
      if (path.includes('channel=general')) return general.promise;
      if (path.includes('after=0'))
        return [
          {
            id: 5,
            channel: 'research',
            at: now.toISOString(),
            author: 'Alice',
            body: 'Current channel',
            attachment: null,
          },
        ];
      return [];
    });
    await render(<ChatPage ctx={context('chat')} />);
    await click('.chat-channels button:nth-child(2)');
    expect(container.textContent).toContain('Current channel');
    await act(async () =>
      general.resolve([
        {
          id: 1,
          channel: 'general',
          at: now.toISOString(),
          author: 'Bob',
          body: 'Old channel',
          attachment: null,
        },
      ]),
    );
    expect(container.textContent).not.toContain('Old channel');
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(request).toHaveBeenCalledWith('/plugins/chat/messages?channel=research&after=5');
    expect(container.querySelectorAll('.chat-message')).toHaveLength(1);
    await render(<ChatPage ctx={context('chat', false)} />);
    expect(vi.getTimerCount()).toBe(0);
    await render(<ChatPage ctx={context('chat')} />);
    expect(container.textContent).toContain('Old channel');
    expect(container.textContent).not.toContain('Current channel');
  });

  it('loads notification settings when enabled', async () => {
    request.mockResolvedValue({
      channels: [],
      rules: [],
      kinds: [],
      event_types: [],
      placeholders: [],
      log: [],
      ai_ready: false,
    });
    await render(<NotifyPage ctx={context('notify', false)} />);
    expect(request).not.toHaveBeenCalled();
    await render(<NotifyPage ctx={context('notify')} />);
    expect(request).toHaveBeenCalledWith('/plugins/notify');
    expect(container.textContent).toContain('Add channel');
  });
});

it.each(['en', 'zh-CN'] as const)(
  'keeps age and Refresh during collection, and opens the health panel in %s',
  async (locale) => {
    setLocale(locale);
    const data = serverDemo();
    data.as_of = new Date(now.getTime() - 8 * 60000).toISOString();
    data.sources[0].failures = 2;
    data.sources[0].next_due_at = now.toISOString();
    const pending = deferred<{ status: string }>();
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language: locale };
      if (path === '/health')
        return {
          polling: true,
          background_errors: {
            'collector:schedule': { at: now.toISOString(), error: 'schedule failed' },
          },
          unreadable_rows: { snapshots: 2 },
        };
      if (path === '/refresh') return pending.promise;
      return [];
    });
    await render(<App />);
    expect(container.querySelector('.banner.red[role="alert"]')?.textContent).toContain(
      t('health.collectorFault'),
    );
    const pill = container.querySelector<HTMLButtonElement>('.health-pill')!;
    expect(pill.textContent).toContain(t('time.minutesAgo', { count: 8 }));
    expect(pill.title).toContain(dateTime(data.as_of));
    expect(pill.title).not.toContain(data.as_of);
    expect(pill.getAttribute('aria-label')).toBe(
      t('health.accessible', {
        title: t('health.title'),
        status: t('health.withAge', {
          label: t('health.collectorFault'),
          age: t('time.minutesAgo', { count: 8 }),
        }),
      }),
    );
    expect(container.querySelector('.collecting-count')?.textContent).toBe(
      t('health.collecting', { count: 1 }),
    );
    const refresh = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('topbar.refresh')}"]`,
    )!;
    expect(refresh.disabled).toBe(false);
    await click(`button[aria-label="${t('topbar.refresh')}"]`);
    expect(refresh.disabled).toBe(true);
    await act(async () => pending.resolve({ status: 'running' }));
    expect(refresh.disabled).toBe(false);
    pill.focus();
    await click('.health-pill');
    const panel = container.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain(t('health.unreadable', { count: 2 }));
    expect(panel.textContent).toContain('schedule failed');
    expect(panel.textContent).toContain(t('health.backoff', { count: 2 }));
    const retry = [...panel.querySelectorAll('button')].find(
      (button) => button.textContent === t('common.retry'),
    )!;
    await act(async () => retry.click());
    expect(request).toHaveBeenCalledWith('/refresh', { source_id: data.sources[0].id });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(pill);
    for (const page of ['settings', 'toolbox', 'notify', 'chat']) {
      await act(async () => {
        window.location.hash = `#/${page}`;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(container.querySelector('.banner.red[role="alert"]')).toBeNull();
      expect(container.querySelector('.health-pill')).not.toBeNull();
      expect(container.querySelector(`button[aria-label="${t('topbar.refresh')}"]`)).toBeNull();
    }
  },
);

it('panel collection actions only reload example data', async () => {
  const data = serverDemo();
  window.history.replaceState(null, '', '/?demo=true');
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/settings') return { language: 'en' };
    return [];
  });
  await render(<App />);
  await click('.health-pill');
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    '.health-panel .link, .health-panel > .button',
  )) {
    await act(async () => button.click());
  }
  expect(request.mock.calls.some(([, body]) => body !== undefined)).toBe(false);
});

it.each(['en', 'zh-CN'] as const)(
  'does not repeat Unknown in the pill accessible name in %s',
  async (locale) => {
    setLocale(locale);
    const pending = deferred<Dashboard>();
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return pending.promise;
      if (path === '/settings') return { language: locale };
      return [];
    });
    await render(<App />);
    const pill = container.querySelector<HTMLButtonElement>('.health-pill')!;
    expect(pill.getAttribute('aria-label')).toBe(
      t('health.accessible', {
        title: t('health.title'),
        status: t('health.unknown'),
      }),
    );
    expect(pill.title).toBe(t('health.unknown'));
    await act(async () => pending.resolve(serverDemo()));
  },
);

describe.each(['en', 'zh-CN'] as const)('health panel details in %s', (locale) => {
  it.each([null, '2026-10-13T10:00:00Z'])(
    'shows pending sources as queued with prior attempt %s',
    async (lastAttempt) => {
      setLocale(locale);
      const data = serverDemo();
      data.sources = [{ ...data.sources[0], status: 'ready', last_attempt: lastAttempt }];
      data.collecting = [data.sources[0].id];
      const close = vi.fn();
      const panel = () => (
        <HealthPanel
          state={computeHealth(data, null, null, false, false)}
          data={data}
          busy={false}
          refresh={vi.fn()}
          close={close}
        />
      );
      await render(panel());
      expect(container.textContent).toContain(t('health.queued'));
      expect(container.textContent).not.toContain(
        t('health.collectingSince', { time: dateTime(lastAttempt) }),
      );
      data.sources[0].status = 'syncing';
      data.sources[0].last_attempt = now.toISOString();
      await render(panel());
      expect(container.textContent).toContain(
        t('health.collectingSince', { time: dateTime(now.toISOString()) }),
      );
      expect(container.textContent).not.toContain(t('health.queued'));
      await act(async () => {
        container
          .querySelector('.health-panel')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        container.querySelector<HTMLElement>('.health-overlay')!.click();
      });
      expect(close).not.toHaveBeenCalled();
      await act(async () =>
        container
          .querySelector('.health-overlay')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      );
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'labels retained nodes with the oldest age or unknown (missing time: %s)',
    async (missingTime) => {
      setLocale(locale);
      const data = serverDemo();
      const source = data.sources[0];
      data.sources = [{ ...source, capabilities: ['jobs', 'instances'] }];
      const oldest = '2026-10-13T10:00:00Z';
      data.nodes = [
        { ...data.nodes[0], source_id: source.id, observed_at: now.toISOString() },
        {
          ...data.nodes[0],
          id: 'node-b',
          source_id: source.id,
          observed_at: missingTime ? null : oldest,
        },
        { ...data.nodes[0], id: 'node-c', source_id: 'other-source', observed_at: null },
      ];
      await render(
        <HealthPanel
          state={computeHealth(data, null, null, false, false)}
          data={data}
          busy={false}
          refresh={vi.fn()}
          close={vi.fn()}
        />,
      );
      expect(container.textContent).toContain(
        t('health.retained', {
          inventory: t('health.inventory.nodes'),
          time: missingTime ? t('health.unknown') : relativeTime(oldest),
        }),
      );
    },
  );

  it('shows enabled plugin faults with a Toolbox link', async () => {
    setLocale(locale);
    const data = serverDemo();
    const state = computeHealth(
      data,
      {
        status: 'ok',
        started_at: '',
        database_path: '',
        polling: true,
        ssh_installed: true,
        source_count: 1,
        plugins: { notify: { enabled: true } },
        background_errors: { 'notify:events': { at: now.toISOString(), error: 'delivery failed' } },
      },
      null,
      false,
      false,
    );
    expect(state.level).toBe('bad');
    expect(state.label).toBe(t('health.pluginFault'));
    await render(
      <HealthPanel state={state} data={data} busy={false} refresh={vi.fn()} close={vi.fn()} />,
    );
    expect(container.textContent).toContain(t('health.pluginFault'));
    expect(container.textContent).toContain('notify:events: delivery failed');
    expect(container.querySelector('a[href="#/toolbox"]')?.textContent).toBe(t('nav.toolbox'));
  });
});

it.each(['en', 'zh-CN'] as const)(
  'renders one server attention count and opens diagnosis without testing in %s',
  async (locale) => {
    const data = serverDemo();
    const source = data.sources[0];
    source.error = { code: 'ssh_timeout' };
    data.attention = [
      {
        key: `source_failed:${source.id}`,
        kind: 'source_failed',
        subject: { kind: 'source', id: source.id, name: source.name },
        severity: 'error',
        message: { code: 'attention_source_failed', name: source.name },
        details: [{ code: 'ssh_timeout' }, 'second detail'],
        since: source.last_success,
        observed_at: source.last_attempt,
        next_attempt: source.next_due_at!,
        action: 'diagnose',
      },
    ];
    data.attention_count = 1;
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language: locale };
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    expect(container.querySelector('a[href="#/overview"] .badge')?.textContent).toBe('1');
    expect(container.querySelector('#attention .count')?.textContent).toBe('1');
    const tile = [...container.querySelectorAll('.stat')].find(
      (element) => element.querySelector('.stat-label')?.textContent === t('overview.attention'),
    );
    expect(tile?.querySelector('.stat-value')?.textContent).toBe('1');
    const panel = container.querySelector<HTMLElement>('#attention')!;
    panel.scrollIntoView = vi.fn();
    await click('.stat-hint a[href="#attention"]');
    expect(document.activeElement).toBe(panel);
    expect(window.location.hash).not.toBe('#attention');
    expect(container.querySelectorAll('#attention li')).toHaveLength(1);
    expect(container.querySelector('#attention')?.textContent).toContain('second detail');
    expect(container.querySelector('#attention')?.textContent).toContain(
      dateTime(source.next_due_at),
    );
    await click('#attention button');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('h2')?.textContent).toBe(
      t('attention.diagnosis', { name: source.name }),
    );
    expect(dialog.querySelector('form')).toBeNull();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/check'))).toHaveLength(0);
    const test = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === t('sources.testConnection'),
    )!;
    await act(async () => test.click());
    expect(
      request.mock.calls.some(
        ([path, body]) =>
          path === `/sources/${encodeURIComponent(source.id)}/check` && body != null,
      ),
    ).toBe(true);
    const firstCalls = request.mock.calls.filter(([path]) => path.endsWith('/check')).length;
    expect(test.disabled).toBe(false);
    await act(async () => test.click());
    expect(request.mock.calls.filter(([path]) => path.endsWith('/check')).length).toBeGreaterThan(
      firstCalls,
    );
  },
);

it('keeps service attention visible before any sources are connected', async () => {
  const data = dashboard('Cluster A');
  data.sources = [];
  data.attention = [
    {
      key: 'service_loop_failed:collector:schedule',
      mutable: false,
      kind: 'service_loop_failed',
      subject: { kind: 'service', id: 'collector:schedule', name: 'collector:schedule' },
      severity: 'error',
      message: { code: 'attention_service_loop_failed', name: 'collector:schedule' },
      details: ['Scheduler stopped'],
      since: null,
      observed_at: null,
      next_attempt: null,
      action: 'health',
    },
  ];
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/settings') return { language: 'en' };
    if (path === '/health') return null;
    return [];
  });
  await render(<App />);
  expect(container.querySelector('#attention')?.textContent).toContain('Scheduler stopped');
  expect(container.querySelector('#attention .attention-actions')).toBeNull();
  await click('#attention button');
  expect(container.querySelector('.health-panel')).not.toBeNull();
});

it.each(['en', 'zh-CN'] as const)('keeps example diagnosis read-only in %s', async (locale) => {
  setLocale(locale);
  const source = serverDemo().sources[0];
  source.error = { code: 'ssh_timeout' };
  await render(<SourceDiagnosis source={source} demo drivers={[]} />);
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe(t('sources.testConnection'));
  expect(container.textContent).toContain(t('attention.exampleCheck'));
  await act(async () => button.click());
  expect(request).not.toHaveBeenCalled();
});

it.each(['en', 'zh-CN'] as const)('labels failed SSH checks as Checked in %s', async (locale) => {
  const data = serverDemo();
  const item = data.attention!.find((entry) => entry.kind === 'instance_ssh_failed')!;
  expect(item.since).toBeNull();
  expect(item.observed_at).not.toBeNull();
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/settings') return { language: locale };
    if (path === '/health') return null;
    return [];
  });
  await render(<App />);
  const params = { time: dateTime(item.observed_at), age: relativeTime(item.observed_at) };
  const text = container.querySelector('#attention')?.textContent;
  expect(text).toContain(t('attention.checked', params));
  expect(text).not.toContain(t('attention.since', params));
});

it.each(['en', 'zh-CN'] as const)(
  'localizes diagnosis for a source never collected in %s',
  async (locale) => {
    setLocale(locale);
    const source = { ...serverDemo().sources[0], username: '', last_success: null };
    const driver = {
      ...driverInfo([], source.driver),
      label: { en: 'Example scheduler', 'zh-CN': '示例调度器' },
    };
    await render(<SourceDiagnosis source={source} demo={false} drivers={[driver]} />);
    expect(container.querySelector('.modal-header p')?.textContent).toBe(driver.label[locale]);
    expect(container.textContent).toContain(t('health.notCollected'));
    expect(container.textContent).not.toContain(t('attention.lastSuccess', { time: '—' }));
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(['instance', 'toolbox'] as const)('opens the %s attention target', async (action) => {
  const data = serverDemo();
  const instance = data.instances.find((row) => row.id === 'example:runpod:demo-pod')!;
  data.attention = [
    action === 'instance'
      ? data.attention!.find((item) => item.kind === 'instance_ssh_failed')!
      : {
          ...data.attention![0],
          key: 'plugin_error:example',
          kind: 'plugin_error',
          subject: { kind: 'plugin', id: 'example', name: 'Example' },
          message: { code: 'attention_plugin_error', name: 'Example' },
          action,
        },
  ];
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/settings') return { language: 'en' };
    if (path === '/health') return null;
    return [];
  });
  await render(<App />);
  await click('#attention button');
  if (action === 'instance') {
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(instance.name);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(instance.host);
  } else {
    expect(window.location.hash).toBe('#/toolbox');
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    expect(container.querySelector('a[href="#/toolbox"]')?.getAttribute('aria-current')).toBe(
      'page',
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  }
});

it('opens diagnosis from an unmeasured login in the GPUs-in-use hint', async () => {
  const data = serverDemo();
  const source = data.sources[0];
  data.summary.unmeasured = [
    {
      subject: { kind: 'source', id: source.id, name: source.name },
      reason: { code: 'summary_source_stale' },
    },
  ];
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/settings') return { language: 'en' };
    if (path === '/health') return null;
    return [];
  });
  await render(<App />);
  await click('.stat-hint button');
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('h2')?.textContent).toBe(
    t('attention.diagnosis', { name: source.name }),
  );
  expect(dialog.querySelector('form')).toBeNull();
  expect(request.mock.calls.some(([path]) => path.endsWith('/check'))).toBe(false);
});

describe('visible dashboard polling', () => {
  function mockDashboard(data: Dashboard) {
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard'))
        return path.includes(`since=${data.token}`) ? { unchanged: true, token: data.token } : data;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      if (path === '/refresh') return { status: 'started' };
      if (path.endsWith('/probe'))
        return {
          ...data.instances.find((item) => path.includes(encodeURIComponent(item.id))),
          name: 'Probed machine',
        };
      return [];
    });
  }

  it('retains an unchanged dashboard and polls auxiliary state, but sends nothing while hidden', async () => {
    const data = { ...dashboard('Cluster A'), token: 'live-token' };
    mockDashboard(data);
    window.history.replaceState(null, '', '/#/jobs');
    await render(<App />);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=live-token');
    for (const path of ['/health', '/toolbox', '/nodes?demo=false'])
      expect(request).toHaveBeenCalledWith(path);
    expect(container.textContent).toContain('Cluster A');
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    request.mockClear();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(request).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=live-token');
    expect(request).toHaveBeenCalledWith(
      '/events?limit=12&demo=false&group=1&include=changes&delivery=true',
    );
    request.mockClear();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=live-token');
    await render(null);
    request.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('follows Refresh every second for sixty seconds while collecting, with auxiliaries only every ten', async () => {
    const data = {
      ...serverDemo(),
      mode: 'live' as const,
      token: 'live-token',
      collecting: ['source-a'],
    };
    mockDashboard(data);
    await render(<App />);
    request.mockClear();
    await click(`button[aria-label="${t('topbar.refresh')}"]`);
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(request).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/dashboard?demo=false&since=live-token',
    ]);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(9);
    for (const path of ['/health', '/toolbox', '/nodes?demo=false'])
      expect(request.mock.calls.filter(([each]) => each === path)).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(50000));
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(request).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=live-token');
  });

  it.each(['refresh', 'probe', 'add'] as const)(
    'does not start following after a failed %s',
    async (action) => {
      const data = { ...serverDemo(), mode: 'live' as const, token: 'live-token' };
      mockDashboard(data);
      if (action !== 'refresh') window.history.replaceState(null, '', '/#/cloud');
      await render(<App />);
      if (action === 'probe') await click('tr.clickable');
      if (action === 'add') await click(`button[aria-label="${t('cloud.add')}"]`);
      request.mockRejectedValueOnce(new Error('Request failed'));
      if (action === 'refresh') await click(`button[aria-label="${t('topbar.refresh')}"]`);
      if (action === 'probe') await click('.drawer .button.primary');
      if (action === 'add') {
        await act(async () => {
          container
            .querySelector('form')!
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
      }
      expect(container.textContent).toContain('Request failed');
      request.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(9999));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(0);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
    },
  );

  it('lets a slow follow-up finish without piling up requests or discarding its data', async () => {
    const data = { ...dashboard('Cluster A'), token: 'live-token', collecting: ['source-a'] };
    const slow = deferred<Dashboard>();
    let pending = false;
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return pending ? slow.promise : data;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      if (path === '/refresh') return { status: 'started' };
      return [];
    });
    await render(<App />);
    await click(`button[aria-label="${t('topbar.refresh')}"]`);
    pending = true;
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
    await act(async () =>
      slow.resolve({
        ...dashboard('Updated cluster'),
        token: 'next-token',
        collecting: ['source-a'],
      }),
    );
    expect(container.textContent).toContain('Updated cluster');
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=next-token');
  });

  it.each([1000, 10000])(
    'supersedes a hung poll after ten seconds at the %i ms cadence and ignores its late reply',
    async (cadence) => {
      const original = { ...dashboard('Cluster A'), token: 'live-token', collecting: ['source-a'] };
      const newer = {
        ...dashboard('Updated cluster'),
        token: 'next-token',
        collecting: ['source-a'],
      };
      const hung = deferred<Dashboard>();
      let reply: Dashboard | Promise<Dashboard> = original;
      request.mockImplementation(async (path) => {
        if (path.startsWith('/dashboard')) return reply;
        if (path === '/settings') return { language: 'en' };
        if (path === '/health') return null;
        if (path === '/refresh') return { status: 'started' };
        return [];
      });
      await render(<App />);
      if (cadence === 1000) await click(`button[aria-label="${t('topbar.refresh')}"]`);
      reply = hung.promise;
      request.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(cadence));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(9999));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
      reply = newer;
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(2);
      expect(container.textContent).toContain('Updated cluster');
      await act(async () => hung.resolve(original));
      expect(container.textContent).toContain('Updated cluster');
      expect(container.textContent).not.toContain('Cluster A');
      request.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(cadence));
      expect(request).toHaveBeenCalledWith('/dashboard?demo=false&since=next-token');
    },
  );

  it('drops the previous mode token and refreshes Activity when the token changes', async () => {
    let data = { ...dashboard('Cluster A'), token: 'live-token' };
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard'))
        return path.includes(`since=${data.token}`) ? { unchanged: true, token: data.token } : data;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      return [];
    });
    window.history.replaceState(null, '', '/#/jobs');
    await render(<App />);
    request.mockClear();
    data = { ...data, token: 'next-token' };
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(request).toHaveBeenCalledWith(
      '/events?limit=12&demo=false&group=1&include=changes&delivery=true',
    );
    request.mockClear();
    await click('[role="switch"]');
    expect(request).toHaveBeenCalledWith('/dashboard?demo=true');
    expect(request.mock.calls.some(([path]) => path.includes('demo=true&since='))).toBe(false);
  });

  it('keeps relative ages moving when the dashboard and auxiliary state do not change', async () => {
    const data = { ...dashboard('Cluster A'), token: 'live-token', as_of: now.toISOString() };
    mockDashboard(data);
    await render(<App />);
    const before = container.querySelector('.health-pill')!.textContent;
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(container.querySelector('.health-pill')!.textContent).not.toBe(before);
    expect(container.querySelector('.health-pill')!.textContent).toContain(
      t('time.minutesAgo', { count: 1 }),
    );
  });

  it('pauses Chat polling and resumes immediately on visibility and focus', async () => {
    request.mockImplementation(async (path) =>
      path === '/plugins/chat' ? { channels: [], max_file_mb: 25 } : [],
    );
    await render(<ChatPage ctx={context('chat')} />);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(request).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledWith('/plugins/chat/messages?channel=general&after=0');
    request.mockClear();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(request).toHaveBeenCalledWith('/plugins/chat/messages?channel=general&after=0');
  });
});

it('announces health without clock chatter and gives retry buttons source-specific names', async () => {
  const data = serverDemo();
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path === '/health') return { status: 'ok', polling: true };
    return [];
  });
  await render(<App />);
  const live = container.querySelector('.health-status [role="status"]')!;
  const before = live.textContent;
  expect(before).toBe(computeHealth(data, null, null, false, false).label);
  expect(live.closest('button')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(live.textContent).toBe(before);
  await click('.health-pill');
  const retries = [...container.querySelectorAll<HTMLButtonElement>('.health-row .link')];
  expect(retries.length).toBe(data.sources.length);
  expect(new Set(retries.map((button) => button.getAttribute('aria-label'))).size).toBe(
    retries.length,
  );
  for (const retry of retries)
    expect(retry.getAttribute('aria-label')).toContain(t('common.retry'));
});

it('keeps real host identifiers out of example collection-machine text', async () => {
  window.history.replaceState(null, '', '/?demo=true#/sources');
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return serverDemo();
    if (path === '/health')
      return { status: 'ok', server_host: 'private-host-fixture', polling: true };
    return [];
  });
  await render(<App />);
  expect(container.textContent).not.toContain('private-host-fixture');
  expect(container.textContent).toContain(t('where.local'));
});

it.each(['queued', 'syncing'])(
  'does not call an active %s source overdue in attention or diagnosis',
  async (state) => {
    const data = serverDemo();
    const source = data.sources.find((source) => source.stale && !source.error)!;
    source.next_due_at = new Date(now.getTime() - 10 * 60000).toISOString();
    source.status = state === 'syncing' ? 'syncing' : 'ready';
    data.collecting = state === 'queued' ? [source.id] : [];
    data.attention = data.attention!.filter((item) => item.subject.id === source.id);
    data.attention[0].next_attempt = source.next_due_at;
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    const next = t('health.nextAttempt', { time: dateTime(source.next_due_at) });
    expect(container.querySelector('#attention')?.textContent).toContain(next);
    expect(container.querySelector('#attention')?.textContent).not.toContain(
      t('health.overdue', { time: dateTime(source.next_due_at) }),
    );
    await click('#attention button');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(next);
    expect(dialog.textContent).not.toContain(t('health.overdueReason'));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'saves selected job outcomes from Notify in %s',
  async (locale) => {
    setLocale(locale);
    request.mockResolvedValue({
      channels: [{ id: 'team', name: 'Team', kind: 'webhook', config: {} }],
      rules: [],
      kinds: [],
      event_types: ['job.finished', 'job.started'],
      placeholders: ['outcome'],
      log: [],
      ai_ready: false,
    });
    await render(<NotifyPage ctx={{ ...context('notify'), groups: [] }} />);
    const add = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(t('notify.addRule')),
    );
    await act(async () => add!.click());
    expect(container.textContent).toContain(t('notify.rule.outcomes'));
    expect(container.textContent).toContain(t('notify.rule.outcomesHint'));
    const finished = container.querySelector<HTMLInputElement>(
      'input[name="events"][value="job.finished"]',
    )!;
    finished.checked = false;
    const previewButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === t('notify.preview'),
    )!;
    request.mockResolvedValueOnce({ subject: 'Preview', body: 'Sample', example: true });
    await act(async () => previewButton.click());
    expect(request).toHaveBeenCalledWith(
      '/plugins/notify/rules/preview',
      expect.objectContaining({ events: ['job.finished'], outcomes: EMPTY_RULE.outcomes }),
    );
    finished.checked = true;
    const outcomes = container.querySelectorAll<HTMLInputElement>('input[name="outcomes"]');
    expect(outcomes).toHaveLength(10);
    for (const checkbox of outcomes) checkbox.checked = checkbox.value === 'timeout';
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'Timeouts';
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(request).toHaveBeenCalledWith(
      '/plugins/notify/rules',
      expect.objectContaining({ events: ['job.finished'], outcomes: ['timeout'] }),
      'POST',
    );
  },
);

it.each(['en', 'zh-CN'] as const)('shows saved Notify outcome filters in %s', async (language) => {
  setLocale(language);
  request.mockResolvedValue({
    channels: [{ id: 'team', name: 'Team', kind: 'webhook', config: {} }],
    rules: [
      { ...EMPTY_RULE, id: 'failures', name: 'Failures', channels: ['team'] },
      { ...EMPTY_RULE, id: 'all', name: 'All', channels: ['team'], outcomes: [] },
    ],
    kinds: [],
    event_types: ['job.finished'],
    placeholders: [],
    log: [],
    ai_ready: false,
  });
  await render(<NotifyPage ctx={{ ...context('notify'), groups: [] }} />);
  const summaries = Array.from(container.querySelectorAll('.rows .sub')).map(
    (row) => row.textContent,
  );
  const label = t('notify.event.finished');
  expect(summaries).toContain(
    `${t('notify.rule.filteredOutcomes', { event: label, outcomes: EMPTY_RULE.outcomes!.map((outcome) => t(OUTCOME_LABELS[outcome])).join(t('common.listSeparator')) })} → Team`,
  );
  expect(summaries).toContain(`${label} → Team`);
});

it.each([
  ['en', false],
  ['zh-CN', false],
  ['en', true],
  ['zh-CN', true],
] as const)('expands a collection in Activity in %s (capped: %s)', async (language, capped) => {
  setLocale(language);
  const count = capped ? 60 : 3;
  const children: DeckEvent[] = Array.from({ length: capped ? 50 : 3 }, (_, index) => ({
    id: index + 1,
    type: 'job.finished',
    source_id: 'cluster-a',
    at: now.toISOString(),
    data: {
      outcome: ['completed', 'failed', 'unknown'][index % 3],
      observed_at: now.toISOString(),
      since: '2026-10-13T08:00:00Z',
      job: {
        id: `cluster-a:100_${index}`,
        name: 'sweep',
        array_id: '100',
        array_index: String(index),
      },
    },
  }));
  request.mockResolvedValue([
    {
      ...children[2],
      group: {
        count,
        ids: Array.from({ length: count }, (_, i) => i + 1),
        first_at: now.toISOString(),
        last_at: now.toISOString(),
        names: [{ name: 'sweep', count }],
        events: children,
      },
    },
  ]);
  await render(<ActivityPanel demo={false} />);
  expect(request).toHaveBeenCalledWith(
    '/events?limit=12&demo=false&group=1&include=changes&delivery=true',
  );
  const summary = container.querySelector('summary')!;
  expect(summary.textContent).toContain(`sweep ×${count}`);
  expect(summary.textContent).toContain(t('notify.event.finished'));
  expect(summary.querySelector('.dot.red')).not.toBeNull();
  expect(container.querySelector('details')!.open).toBe(false);
  await click('summary');
  expect(container.querySelector('details')!.open).toBe(true);
  expect(container.querySelectorAll('details li')).toHaveLength(capped ? 51 : 3);
  if (capped) {
    expect(container.querySelector('details li:last-child')!.textContent).toBe(
      t('event.more', { count: 10 }),
    );
  } else {
    expect(container.textContent).not.toContain(t('event.more', { count: 0 }));
  }
  for (let index = 0; index < 3; index++) {
    expect(container.querySelectorAll('details li')[index].textContent).toContain(
      `sweep [100_${index}]`,
    );
  }
  for (const outcome of ['completed', 'failed', 'unknown']) {
    expect(container.querySelector('details')!.textContent).toContain(t(OUTCOME_LABELS[outcome]));
  }
  expect(summary.textContent).toContain(
    t('event.between', {
      start: new Date('2026-10-13T08:00:00Z').toLocaleTimeString(language, {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }),
      end: now.toLocaleTimeString(language, { hour12: false, hour: '2-digit', minute: '2-digit' }),
    }),
  );
  await click('summary');
  expect(container.querySelector('details')!.open).toBe(false);
});

it.each(['en', 'zh-CN'] as const)(
  'shows grouped Notify delivery counts in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue({
      channels: [],
      rules: [],
      kinds: [],
      event_types: [],
      placeholders: [],
      ai_ready: false,
      log: [{ id: 1, at: now.toISOString(), status: 'grouped', count: 50, digest: 1 }],
    });
    await render(<NotifyPage ctx={{ ...context('notify'), groups: [] }} />);
    expect(container.textContent).toContain(t('notify.status.grouped'));
    expect(container.textContent).toContain(t('notify.groupedCount', { count: 50 }));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'labels suppressed digests without claiming a message in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue({
      channels: [],
      rules: [],
      kinds: [],
      event_types: [],
      placeholders: [],
      ai_ready: false,
      log: [{ id: 1, at: now.toISOString(), status: 'suppressed', count: 600, digest: 1 }],
    });
    await render(<NotifyPage ctx={{ ...context('notify'), groups: [] }} />);
    expect(container.textContent).toContain(t('notify.suppressedCount', { count: 600 }));
    expect(container.textContent).not.toContain(t('notify.groupCount', { count: 600 }));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'shows message counts only for channel deliveries in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue({
      channels: [],
      rules: [],
      kinds: [],
      event_types: [],
      placeholders: [],
      ai_ready: false,
      log: [
        { id: 1, at: now.toISOString(), status: 'failed', count: 3 },
        { id: 2, at: now.toISOString(), status: 'sent', channel: 'team', count: 0 },
        { id: 3, at: now.toISOString(), status: 'sent', channel: 'team', count: 4 },
        { id: 4, at: now.toISOString(), status: 'failed', channel: 'team', count: 5 },
      ],
    });
    await render(<NotifyPage ctx={{ ...context('notify'), groups: [] }} />);
    expect(container.textContent).not.toContain(t('notify.groupCount', { count: 3 }));
    expect(container.textContent).toContain(t('notify.groupCount', { count: 4 }));
    expect(container.textContent).toContain(t('notify.groupCount', { count: 5 }));
    const zeroMessage = container.querySelectorAll('tbody tr')[1].querySelectorAll('td')[1];
    expect(zeroMessage.textContent).toBe('—');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'renders gap rows without job actions in %s',
  async (language) => {
    setLocale(language);
    const rows: DeckEvent[] = [
      {
        id: 2,
        type: 'source.gap',
        at: now.toISOString(),
        source_id: 'cluster-a-alice',
        data: {
          source_name: 'Cluster A',
          unobserved_from: '2026-10-11T08:00:00Z',
          unobserved_to: now.toISOString(),
          failures_checked_from: '2026-10-12T12:00:00Z',
        },
      },
      {
        id: 1,
        type: 'service.gap',
        at: now.toISOString(),
        source_id: null,
        data: { from: '2026-10-12T16:00:00Z', to: now.toISOString() },
      },
    ];
    request.mockResolvedValue(rows);
    await render(<ActivityPanel demo={false} onOpen={vi.fn()} />);
    expect(container.querySelectorAll('.activity > li')).toHaveLength(2);
    expect(container.querySelectorAll('.activity .dot.gray')).toHaveLength(2);
    expect(container.querySelector('.activity button')).toBeNull();
    expect(container.textContent).toContain(language === 'en' ? 'was not observed' : '未被观测');
    expect(container.textContent).toContain(
      language === 'en' ? 'computer was asleep' : '电脑处于睡眠状态',
    );
    expect(container.textContent).toContain(dateTime(rows[0].data.unobserved_from));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'links source changes only while their subject exists in %s',
  async (language) => {
    setLocale(language);
    const source = dashboard('Cluster A').sources[0];
    const rows: DeckEvent[] = [
      {
        id: 3,
        type: 'change.source',
        at: now.toISOString(),
        source_id: source.id,
        data: { subject_id: source.id, name: 'Cluster A', action: 'disabled', fields: ['enabled'] },
      },
      {
        id: 2,
        type: 'change.source',
        at: now.toISOString(),
        source_id: 'removed',
        data: { subject_id: 'removed', name: 'Cluster B', action: 'removed', fields: [] },
      },
      {
        id: 1,
        type: 'change.source',
        at: now.toISOString(),
        source_id: 'removed',
        data: { subject_id: 'removed', name: 'Cluster B', action: 'added', fields: [] },
      },
    ];
    request.mockResolvedValue(rows);
    await render(<ActivityPanel demo={false} sources={[source]} onOpen={vi.fn()} />);
    expect(request).toHaveBeenCalledWith(
      '/events?limit=12&demo=false&group=1&include=changes&delivery=true',
    );
    expect(container.querySelectorAll('.activity a')).toHaveLength(1);
    expect(container.querySelector('.activity a')?.getAttribute('href')).toBe(
      '#/sources?group=cluster-a',
    );
    expect(container.querySelectorAll('.activity .dot.gray')).toHaveLength(3);
    expect(container.querySelector('.activity button')).toBeNull();
    expect(container.querySelector('.activity small')).toBeNull();
    expect(container.textContent).toContain(
      language === 'en' ? 'You paused Cluster A' : '你暂停了 Cluster A 的采集',
    );
    // A dashboard poll removes the link even if the Activity rows did not change.
    await render(<ActivityPanel demo={false} sources={[]} onOpen={vi.fn()} />);
    expect(container.querySelector('.activity a')).toBeNull();
    expect(container.querySelectorAll('.activity > li')).toHaveLength(3);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'uses localized tool names and stored names for removed tools in %s',
  async (language) => {
    setLocale(language);
    const tools = [
      { ...context('notify').tools[0], name: { en: 'Notifications', 'zh-CN': '任务提醒' } },
      { ...context('chat').tools[0], name: { en: 'Team messages', 'zh-CN': '团队留言' } },
    ];
    const rows: DeckEvent[] = [...tools, { id: 'removed', name: { en: 'Old tool' } }].map(
      (tool, id) => ({
        id,
        type: 'change.tool',
        at: now.toISOString(),
        source_id: null,
        data: { subject_id: tool.id, name: tool.name.en, action: 'on', fields: [] },
      }),
    );
    request.mockResolvedValue(rows);
    const data = dashboard('Cluster A');
    const ctx = {
      ...context('jobs'),
      data,
      groups: groupsOf(data),
      group: 'all',
      query: '',
      tools,
    };
    await render(<JobsPage ctx={ctx} />);
    for (const name of language === 'en'
      ? ['Notifications', 'Team messages', 'Old tool']
      : ['任务提醒', '团队留言', 'Old tool']) {
      expect(container.querySelector('.activity')?.textContent).toContain(
        t('event.change.tool.on', { name }),
      );
    }
    // A removed tool keeps its recorded name without needing a new Activity poll.
    await render(<JobsPage ctx={{ ...ctx, tools: [] }} />);
    expect(container.querySelector('.activity')?.textContent).toContain(
      t('event.change.tool.on', { name: 'Notifications' }),
    );
  },
);

it('scrolls only the selected Sources group without hiding other groups', async () => {
  const data = serverDemo();
  const ctx = {
    ...context('sources'),
    data,
    groups: groupsOf(data),
    nodes: [],
    drivers: [],
    demo: true,
  };
  const scroll = vi.mocked(Element.prototype.scrollIntoView);
  const first = ctx.groups.find((group) => group.key === 'example:cluster-b')!;
  const second = ctx.groups.find((group) => group.key === 'example:cluster-d')!;
  await render(<SourcesPage ctx={{ ...ctx, group: first.key }} />);
  const panel = document.getElementById(`source-group:${first.key}`);
  expect(panel?.tagName).toBe('SECTION');
  expect(scroll).toHaveBeenCalledWith({ block: 'start' });
  expect(scroll.mock.contexts.every((element) => element === panel)).toBe(true);
  expect(container.querySelectorAll('.source-group')).toHaveLength(
    ctx.groups.filter((group) => group.sources.length).length + 1,
  );
  scroll.mockClear();
  // Updating dashboard data with the same group must not yank the user's scroll position.
  await render(<SourcesPage ctx={{ ...ctx, groups: [...ctx.groups], group: first.key }} />);
  expect(scroll).not.toHaveBeenCalled();
  await render(<SourcesPage ctx={{ ...ctx, group: second.key }} />);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.contexts[0]).toBe(document.getElementById(`source-group:${second.key}`));
  for (const group of ['all', 'missing']) {
    scroll.mockClear();
    await render(<SourcesPage ctx={{ ...ctx, group }} />);
    expect(scroll).not.toHaveBeenCalled();
    expect(container.textContent).toContain(first.label);
    expect(container.textContent).toContain(second.label);
  }
  const manual = ctx.groups.find((group) => !group.sources.length)!;
  await render(<SourcesPage ctx={{ ...ctx, group: manual.key }} />);
  expect(scroll.mock.contexts).toEqual([document.getElementById('source-manual')]);
});

it.each(['en', 'zh-CN'] as const)(
  'shows only relevant changed field names in %s',
  async (language) => {
    setLocale(language);
    const row = (type: string, action: string, fields: string[]): DeckEvent => ({
      id: 0,
      type,
      at: now.toISOString(),
      source_id: null,
      data: {
        name: 'Example',
        action,
        fields,
        ...{ credential: 'secret-value', options: { region: 'private-region' } },
      },
    });
    const rows = [
      row('change.source', 'edited', ['credential', 'options']),
      row('change.source', 'disabled', ['enabled']),
      row('change.source', 'added', ['credential']),
      row('change.source', 'enabled', ['enabled', 'interval_minutes', 'options']),
      row('change.source', 'disabled', ['enabled', 'credential']),
      row('change.node', 'edited', ['ssh_alias', 'command']),
      row('change.instance', 'edited', ['host', 'port']),
      row('change.source', 'removed', ['credential']),
      row('change.tool', 'settings', ['credential']),
      row('change.import', 'imported', ['credential']),
      row('change.source', 'edited', []),
    ].map((event, id) => ({ ...event, id }));
    request.mockResolvedValue(rows);
    await render(<ActivityPanel demo={false} />);
    const rendered = [...container.querySelectorAll('.activity > li')];
    const changed = (fields: string[]) =>
      t('event.change.fields', {
        fields: fields.map(changeFieldLabel).join(t('common.listSeparator')),
      });
    for (const [index, fields] of [
      [0, ['credential', 'options']],
      [3, ['interval_minutes', 'options']],
      [4, ['credential']],
      [5, ['ssh_alias', 'command']],
      [6, ['host', 'port']],
    ] as const) {
      expect(rendered[index].querySelector('small')?.textContent).toBe(changed([...fields]));
    }
    for (const index of [1, 2, 7, 8, 9, 10])
      expect(rendered[index].querySelector('small')).toBeNull();
    expect(container.textContent).not.toContain('secret-value');
    expect(container.textContent).not.toContain('private-region');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'acknowledges, snoozes and unmutes attention with shared counts in %s',
  async (locale) => {
    const data = serverDemo();
    setLocale(locale);
    const healthBefore = computeHealth(data, null, null, false, false);
    request.mockImplementation(async (path, body, method) => {
      if (path.startsWith('/dashboard')) return structuredClone(data);
      if (path === '/settings') return { language: locale };
      if (path === '/health') return null;
      if (path.startsWith('/attention/')) {
        expect(method).toBe('PUT');
        const item = data.attention!.find(
          (row) => row.key === decodeURIComponent(path.slice('/attention/'.length)),
        )!;
        const action = body as { action: string; until?: string; fingerprint?: string };
        expect(action.fingerprint).toBe(action.action === 'clear' ? undefined : item.fingerprint);
        item.muted =
          action.action === 'clear'
            ? null
            : {
                state: action.action === 'snooze' ? 'snoozed' : 'acknowledged',
                at: now.toISOString(),
                until: action.until ? new Date(now.getTime() + 3600000).toISOString() : null,
              };
        data.attention_count = data.attention!.filter((row) => !row.muted).length;
        return { status: 'ok' };
      }
      return [];
    });
    await render(<App />);
    const assertCounts = (count: number) => {
      expect(container.querySelector('a[href="#/overview"] .badge')?.textContent).toBe(
        count ? String(count) : undefined,
      );
      expect(container.querySelector('#attention .count')?.textContent).toBe(String(count));
      const tile = [...container.querySelectorAll('.stat')].find(
        (element) => element.querySelector('.stat-label')?.textContent === t('overview.attention'),
      );
      expect(tile?.querySelector('.stat-value')?.textContent).toBe(String(count));
    };
    assertCounts(5);
    expect(container.querySelector<HTMLDetailsElement>('.attention-muted')!.open).toBe(false);
    expect(container.querySelector('.attention-muted > summary')?.textContent).toBe(
      t('attention.acknowledged', { count: 2 }),
    );
    expect(container.querySelector('.attention-muted')?.textContent).toContain(
      t('attention.snoozedUntil', {
        time: dateTime(
          data.attention!.find((item) => item.muted?.state === 'snoozed')!.muted!.until,
        ),
      }),
    );
    const key = data.attention![0].key;
    await click('#attention > ul .attention-actions button');
    expect(request).toHaveBeenCalledWith(
      `/attention/${encodeURIComponent(key)}`,
      { action: 'acknowledge', until: undefined, fingerprint: data.attention![0].fingerprint },
      'PUT',
    );
    assertCounts(4);
    expect(document.activeElement?.id).toBe('attention');
    expect(container.querySelector('.toast[role="status"]')?.textContent).toContain(
      t('attention.acknowledgedToast'),
    );
    expect(container.querySelector('.attention-muted > summary')?.textContent).toBe(
      t('attention.acknowledged', { count: 3 }),
    );
    await click('.attention-muted summary');
    await click('.attention-muted .attention-actions button');
    assertCounts(5);
    expect(document.activeElement?.id).toBe('attention');
    expect(container.querySelector('.toast[role="status"]')?.textContent).toContain(
      t('attention.unmutedToast'),
    );
    for (const until of ['1h', 'tomorrow']) {
      const selector = `#attention > ul .attention-actions button:nth-child(${until === '1h' ? 2 : 3})`;
      const button = container.querySelector<HTMLButtonElement>(selector)!;
      expect(button.textContent).toBe(
        t(until === '1h' ? 'attention.oneHour' : 'attention.tomorrow'),
      );
      const writes = request.mock.calls.filter(([path]) => path.startsWith('/attention/')).length;
      await act(async () => {
        button.focus();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      expect(request.mock.calls.filter(([path]) => path.startsWith('/attention/'))).toHaveLength(
        writes,
      );
      assertCounts(until === '1h' ? 5 : 4);
      await click(selector);
      expect(document.activeElement?.id).toBe('attention');
      expect(container.querySelector('.toast[role="status"]')?.textContent).toContain(
        t('attention.snoozedToast'),
      );
      expect(
        request.mock.calls.some(
          ([path, body, method]) =>
            path.startsWith('/attention/') &&
            method === 'PUT' &&
            (body as { until?: string })?.until === until,
        ),
      ).toBe(true);
    }
    assertCounts(3);
    await click('#attention > ul .attention-actions button');
    assertCounts(2);
    await click('#attention > ul .attention-actions button');
    assertCounts(1);
    await click('#attention > ul .attention-actions button');
    assertCounts(0);
    expect(container.querySelector('#attention > .panel-note')?.textContent).toBe(
      t('attention.allMuted'),
    );
    expect(container.querySelector('#attention > ul')).toBeNull();
    expect(computeHealth(data, null, null, false, false)).toEqual(healthBefore);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'keeps example attention controls read-only in %s',
  async (locale) => {
    window.history.replaceState(null, '', '/?demo=true');
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return serverDemo();
      if (path === '/settings') return { language: locale };
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    const controls = container.querySelectorAll<HTMLButtonElement>('.attention-actions button');
    expect(controls.length).toBeGreaterThan(0);
    const notes = container.querySelectorAll('#attention #attention-demo-note');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(t('toast.demoReadOnly'));
    expect(
      container.querySelector('#attention')!.textContent!.split(t('toast.demoReadOnly')),
    ).toHaveLength(2);
    for (const control of controls) {
      expect(control.disabled).toBe(true);
      const descriptions = control.getAttribute('aria-describedby')!.split(' ');
      expect(descriptions).toHaveLength(2);
      expect(descriptions[1]).toBe('attention-demo-note');
      expect(document.getElementById(descriptions[0])).toBe(
        control.closest('li')!.querySelector('strong'),
      );
      await act(async () => control.click());
    }
    expect(request.mock.calls.some(([path]) => path.startsWith('/attention/'))).toBe(false);
  },
);

it('keeps a failed acknowledgement visible and reports the error', async () => {
  const data = serverDemo();
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) return data;
    if (path.startsWith('/attention/')) throw new Error('Save failed');
    if (path === '/health') return null;
    return [];
  });
  await render(<App />);
  await click('#attention > ul .attention-actions button');
  expect(container.querySelector('#attention .count')?.textContent).toBe('5');
  expect(container.textContent).toContain('Save failed');
  expect(
    container.querySelector<HTMLButtonElement>('#attention > ul .attention-actions button')
      ?.disabled,
  ).toBe(false);
});

it.each(['en', 'zh-CN'] as const)(
  'reloads changed attention after failed actions and keeps the error in %s',
  async (locale) => {
    const data = serverDemo();
    let reads = 0;
    request.mockImplementation(async (path, body) => {
      if (path.startsWith('/dashboard')) {
        reads += 1;
        return structuredClone(data);
      }
      if (path === '/settings') return { language: locale };
      if (path === '/health') return null;
      if (path.startsWith('/attention/')) {
        data.attention![0].fingerprint = `changed-${reads}`;
        data.attention![0].details = [`Changed cause ${reads}`];
        if ((body as { action: string }).action === 'clear') throw new Error('Save failed');
        throw new ApiError(409, { code: 'attention_changed' });
      }
      return [];
    });
    await render(<App />);
    for (const action of ['acknowledge', 'snooze', 'clear']) {
      const before = reads;
      if (action === 'acknowledge') {
        await click('#attention > ul .attention-actions button');
      } else if (action === 'snooze') {
        await click('#attention > ul .attention-actions button:nth-child(2)');
      } else {
        await click('.attention-muted summary');
        await click('.attention-muted .attention-actions button');
      }
      expect(reads).toBeGreaterThan(before);
      expect(container.querySelector('#attention')?.textContent).toContain(
        `Changed cause ${before}`,
      );
      expect(container.textContent).toContain(
        action === 'clear' ? 'Save failed' : t('msg.attention_changed'),
      );
      expect(container.querySelector('#attention .count')?.textContent).toBe('5');
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'polls Notify only when on and visible in %s',
  async (language) => {
    setLocale(language);
    const state = {
      channels: [],
      rules: [],
      kinds: [],
      event_types: [],
      placeholders: [],
      ai_ready: false,
      log: [],
    };
    request.mockResolvedValue(state);
    await render(<NotifyPage ctx={context('notify')} />);
    request.mockResolvedValue({
      ...state,
      log: [{ id: 1, at: now.toISOString(), status: 'failed' }],
    });
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(request).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(t('notify.status.failed'));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(request).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledTimes(1);
    await render(<NotifyPage ctx={context('notify', false)} />);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(request).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'shows linked notification outcomes without inventing missing ones in %s',
  async (language) => {
    setLocale(language);
    const row = {
      id: 1,
      type: 'source.recovered',
      at: now.toISOString(),
      source_id: 'a',
      data: { source_name: 'Cluster A' },
    };
    request.mockResolvedValue([
      { ...row, delivery: ['failed', 'sent', 'grouped', 'suppressed'] },
      { ...row, id: 2 },
    ]);
    await render(<ActivityPanel demo={false} />);
    const shown = container.querySelectorAll('.activity > li');
    expect(shown[0].textContent).toContain(
      t('activity.delivery', {
        statuses: ['failed', 'sent', 'grouped', 'suppressed']
          .map((status) => t(`notify.status.${status}` as Parameters<typeof t>[0]))
          .join(t('common.listSeparator')),
      }),
    );
    expect(shown[1].textContent).not.toContain(t('notify.status.sent'));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'opens Notifications from its labelled channel warning in %s',
  async (language) => {
    setLocale(language);
    window.history.replaceState(null, '', '/?demo=true');
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return serverDemo();
      if (path === '/settings') return { language };
      if (path === '/health') return null;
      return [];
    });
    await render(<App />);
    const warning = [...container.querySelectorAll<HTMLButtonElement>('.attention-open')].find(
      (item) => item.textContent?.includes(t('msg.send_timeout', { seconds: 30 })),
    )!;
    expect(warning.textContent).toContain(
      t('msg.attention_notification_failed', {
        channel: 'Team alerts',
        error_code: t('msg.send_timeout', { seconds: 30 }),
      }),
    );
    expect(warning.textContent).not.toContain('{');
    expect(warning.querySelector('.dot.amber')).not.toBeNull();
    await act(async () => warning.click());
    expect(window.location.hash).toBe('#/notify');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'offers Add source in an empty health panel in %s',
  async (locale) => {
    setLocale(locale);
    const data = { ...serverDemo(), sources: [] };
    const refresh = vi.fn();
    const close = vi.fn();
    const addSource = vi.fn();
    await render(
      <HealthPanel
        state={computeHealth(data, null, null, false, false)}
        data={data}
        busy={false}
        refresh={refresh}
        close={close}
        addSource={addSource}
      />,
    );
    expect(container.textContent).toContain(t('health.noSources'));
    expect(container.textContent).not.toContain(t('health.collectAll'));
    const button = container.querySelector<HTMLButtonElement>('.health-panel > button.button')!;
    expect(button.textContent).toBe(t('source.add'));
    await act(async () => button.click());
    expect(addSource).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  },
);

it.each(['probe', 'add'] as const)(
  'reloads after a completed %s without sixty seconds of polling',
  async (action) => {
    const data = { ...serverDemo(), mode: 'live' as const, token: 'live-token' };
    window.history.replaceState(null, '', '/#/cloud');
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path.endsWith('/probe')) {
        data.instances = [{ ...data.instances[0], name: 'Probed machine' }];
        return data.instances[0];
      }
      if (path === '/instances') return data.instances[0];
      return [];
    });
    await render(<App />);
    request.mockClear();
    if (action === 'probe') {
      await click('tr.clickable');
      await click('.drawer .button.primary');
      expect(request.mock.calls.some(([path]) => path.endsWith('/probe'))).toBe(true);
      expect(container.querySelector('.drawer')?.textContent).toContain('Probed machine');
    } else {
      await click(`button[aria-label="${t('cloud.add')}"]`);
      await act(async () => {
        container
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(request.mock.calls.some(([path]) => path === '/instances')).toBe(true);
    }
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
    request.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
  },
);

it.each([false, true])(
  'reloads a saved source without duplicate reads (enabled: %s)',
  async (enabled) => {
    const source = { ...dashboard('Cluster A').sources[0], enabled };
    let data: Dashboard = { ...dashboard('Cluster A'), sources: [] };
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/drivers') return [driverInfo([], 'slurm')];
      if (path === '/sources') {
        data = { ...data, sources: [source] };
        return source;
      }
      if (path === '/refresh') {
        data = { ...data, collecting: [source.id] };
        return { status: 'started' };
      }
      return [];
    });
    await render(<App />);
    await click('.health-pill');
    await click('.health-panel > button.button');
    await click('.modal .type-card');
    if (!enabled) await click('input[name="enabled"]');
    request.mockClear();
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(
      enabled ? 2 : 1,
    );
    expect(request.mock.calls.filter(([path]) => path === '/refresh')).toHaveLength(
      enabled ? 1 : 0,
    );
    expect(container.textContent).toContain('Cluster A');
    if (enabled) {
      request.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
    }
  },
);

it.each([false, true])('stops following the completed collection (scoped: %s)', async (scoped) => {
  const data = { ...serverDemo(), mode: 'live' as const, token: 'live-token' };
  const target = data.sources[0].id;
  let collecting: string[] = [];
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard'))
      return { ...data, collecting, token: collecting.join(',') || 'done' };
    if (path === '/refresh') {
      collecting = [target, 'unrelated-source'];
      return { status: 'started' };
    }
    return [];
  });
  await render(<App />);
  if (scoped) {
    await click('.health-pill');
    const retry = container.querySelector('.health-row button.link')!;
    await act(async () => (retry as HTMLButtonElement).click());
    expect(request).toHaveBeenCalledWith('/refresh', { source_id: target });
  } else {
    await click(`button[aria-label="${t('topbar.refresh')}"]`);
  }
  request.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(3);
  collecting = scoped ? ['unrelated-source'] : [];
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  request.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(request.mock.calls.filter(([path]) => path.startsWith('/dashboard'))).toHaveLength(1);
});

it('does not stop a new follow-up using a dashboard requested before Refresh', async () => {
  const original = { ...serverDemo(), mode: 'live' as const, token: 'initial', collecting: [] };
  const old = deferred<Dashboard>();
  const started = deferred<Dashboard>();
  let reply: Dashboard | Promise<Dashboard> = original;
  let reads = 0;
  request.mockImplementation(async (path) => {
    if (path.startsWith('/dashboard')) {
      reads += 1;
      return reply;
    }
    if (path === '/refresh') return { status: 'started' };
    return [];
  });
  await render(<App />);
  const initialReads = reads;
  reply = old.promise;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(reads).toBe(initialReads + 1);
  reply = started.promise;
  await click(`button[aria-label="${t('topbar.refresh')}"]`);
  expect(reads).toBe(initialReads + 2);
  await act(async () => old.resolve(original));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(reads).toBe(initialReads + 2);
  reply = { ...original, token: 'pending', collecting: ['source-a'] };
  await act(async () => started.resolve(reply as Dashboard));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(reads).toBe(initialReads + 3);
});

it.each(['en', 'zh-CN'] as const)(
  'opens the add-source dialog directly from the empty health panel in %s',
  async (locale) => {
    setLocale(locale);
    const data = { ...dashboard('Cluster A'), sources: [] };
    request.mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language: locale };
      return [];
    });
    await render(<App />);
    await click('.health-pill');
    expect(container.querySelector('.health-panel')).not.toBeNull();
    await click('.health-panel > button.button');
    expect(container.querySelector('.health-panel')).toBeNull();
    expect(container.querySelector('#modal-title')?.textContent).toBe(t('source.add'));
    expect(request.mock.calls.some(([path]) => path === '/refresh')).toBe(false);
  },
);

it('hides the empty health panel add action in example mode', async () => {
  window.history.replaceState(null, '', '/?demo=true');
  const data = { ...serverDemo(), sources: [] };
  request.mockImplementation(async (path) => (path.startsWith('/dashboard') ? data : []));
  await render(<App />);
  await click('.health-pill');
  const panel = container.querySelector('.health-panel')!;
  expect(panel.textContent).toContain(t('health.noSources'));
  expect(panel.textContent).not.toContain(t('source.add'));
  expect(panel.textContent).not.toContain(t('health.collectAll'));
});

describe.each(['en', 'zh-CN'] as const)('unknown source inventory in %s', (locale) => {
  it.each(['token gate', 'loading', 'unreachable'])(
    'does not offer source actions while %s',
    async (state) => {
      setLocale(locale);
      const pending = deferred<Dashboard>();
      request.mockImplementation(async (path) => {
        if (path === '/settings') return { language: locale };
        if (path.startsWith('/dashboard')) {
          if (state === 'token gate') throw new ApiError(401, { code: 'token_required' });
          if (state === 'unreachable') throw new Error('Service unreachable');
          return pending.promise;
        }
        return [];
      });
      await render(<App />);
      if (state === 'token gate') expect(container.querySelector('.token-gate')).not.toBeNull();
      await click('.health-pill');
      const panel = container.querySelector('.health-panel')!;
      expect(panel.textContent).not.toContain(t('health.noSources'));
      expect(panel.textContent).not.toContain(t('source.add'));
      expect(panel.textContent).not.toContain(t('health.collectAll'));
      expect(request.mock.calls.some(([, body]) => body !== undefined)).toBe(false);
      if (state === 'loading') {
        await act(async () => pending.resolve({ ...dashboard('Cluster A'), sources: [] }));
        expect(panel.textContent).toContain(t('source.add'));
      }
    },
  );
});
