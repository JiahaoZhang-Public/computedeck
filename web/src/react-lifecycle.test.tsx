// @vitest-environment jsdom
import { serverDashboard, serverDemo } from './test-server';
import { act, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Puzzle } from 'lucide-react';
import App from './App';
import { api } from './api';
import { setLocale, t } from './i18n';
import { registerWebPlugin } from './plugins';
import TrendChart from './TrendChart';
import { ChatPage } from './pages/Chat';
import { JobsPage } from './pages/Jobs';
import { groupsOf } from './groups';
import { HistoryPanel } from './pages/HistoryPanel';
import { NotifyPage } from './pages/Notify';
import type { Ctx } from './pages/shared';
import type { Dashboard, HistoryPoint, Tool } from './types';

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
        expect(more?.hasAttribute('aria-expanded')).toBe(false);
        expect(more?.textContent).toBe(t('summary.more', { count: 2 }));
        await act(async () => more!.click());
        expect(hint.textContent).toContain('third-login');
        expect(hint.textContent).toContain('fourth-login');
        expect(hint.contains(more!)).toBe(false);
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
  it('ignores a previous range response and resets errors when selecting another range', async () => {
    const threeDays = deferred<{ points: HistoryPoint[] }>();
    const week = deferred<{ points: HistoryPoint[] }>();
    request.mockImplementation((path) =>
      path.includes('hours=72') ? threeDays.promise : week.promise,
    );
    await render(<HistoryPanel day={[sample(1)]} demo={false} />);
    await click('[role="tab"]:nth-child(2)');
    await click('[role="tab"]:nth-child(3)');
    await act(async () => week.resolve({ points: [sample(2), sample(3)] }));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
    await act(async () => threeDays.reject(new Error('Old request failed')));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
    await click('[role="tab"]:nth-child(2)');
    expect(container.querySelector('.chart-empty')?.textContent).toBe(t('chart.failed'));
    await click('[role="tab"]:nth-child(1)');
    expect(container.querySelector('.chart-empty')).toBeNull();
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
  });

  it('does not display history from the previous demo mode while the new range loads', async () => {
    const demo = deferred<{ points: HistoryPoint[] }>();
    request.mockImplementation(async (path) =>
      path.includes('demo=true') ? demo.promise : { points: [sample(2)] },
    );
    await render(<HistoryPanel day={[]} demo={false} />);
    await click('[role="tab"]:nth-child(2)');
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await click('[role="tab"]:nth-child(2)');
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(1);
    await render(<HistoryPanel day={[]} demo={true} />);
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(0);
    expect(container.querySelector('.chart-empty')?.textContent).toBe(t('chart.loading'));
    await act(async () => demo.resolve({ points: [sample(3), sample(4)] }));
    expect(container.querySelectorAll('.chart-bar')).toHaveLength(2);
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
