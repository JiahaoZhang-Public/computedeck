// @vitest-environment jsdom
import { act, createRef, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { setLocale, t } from './i18n';
import { dateTime } from './domain';
import { jobTime } from './jobFacts';
import { groupsOf } from './groups';
import { serverDemo } from './test-server';
import { ActivityPage as ActivityPageView, ActivityPanel, ActivityTeaser } from './pages/Activity';
import type { Ctx } from './pages/shared';
import type { DeckEvent } from './types';
import { setRouteParams, useRouteParam } from './useRouteParam';

vi.mock('./api', () => ({ api: vi.fn() }));
const request = vi.mocked(api);
let container: HTMLDivElement;
let root: Root;
const clock = new Date('2026-10-21T12:00:00Z');

// Supply the URL-backed search context that App owns in production.
function ActivityPage({ ctx }: { ctx: Ctx }) {
  const [query, setQuery] = useRouteParam('q');
  return <ActivityPageView ctx={{ ...ctx, query, setQuery }} />;
}

function event(id: number): DeckEvent {
  return {
    id,
    type: 'job.finished',
    at: clock.toISOString(),
    source_id: 'example:cluster-b-alice',
    data: {
      outcome: 'failed',
      state: 'FAILED',
      exit_code: '1:0',
      ended_at: clock.toISOString(),
      job: {
        id: `example:cluster-b:${id}`,
        name: `train-${id}`,
        state: 'FAILED',
        elapsed: '1:00',
        node: 'gpu-1',
      },
    },
  };
}
function context(): Ctx {
  const data = serverDemo();
  return {
    data,
    demo: false,
    group: 'all',
    groups: groupsOf(data),
    tools: [],
    nodes: [],
    searchRef: createRef<HTMLInputElement>(),
    setGroup: (group: string) => setRouteParams({ group }),
    openJob: vi.fn(),
    openEvent: vi.fn(),
    openInstance: vi.fn(),
    diagnose: vi.fn(),
  } as unknown as Ctx;
}
async function render(node: ReactNode) {
  await act(async () => root.render(<StrictMode>{node}</StrictMode>));
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/#/activity');
  localStorage.clear();
  setLocale('en');
  request.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['en', 'zh-CN'] as const)(
  'keeps errors distinct from empty and retains the last good panel in %s',
  async (language) => {
    setLocale(language);
    request.mockRejectedValue(new Error('offline'));
    await render(<ActivityPanel demo={false} />);
    expect(container.textContent).toContain(t('activity.error'));
    expect(container.textContent).not.toContain(t('activity.empty'));
    expect(container.querySelector('.panel-note:not([role="alert"])')).toBeNull();
    request.mockResolvedValue([event(1)]);
    await click(t('common.retry'));
    expect(container.textContent).toContain('train-1');
    request.mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTime(15000));
    expect(container.textContent).toContain(t('activity.error'));
    expect(container.textContent).toContain('train-1');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/activity');
  },
);

it('pages older rows and holds new rows behind a pill until clicked', async () => {
  const initial = Array.from({ length: 30 }, (_, i) => event(100 - i));
  request.mockImplementation(async (path) => {
    const params = new URLSearchParams(path.split('?')[1]);
    if (params.has('after_id')) return [event(101)];
    if (params.has('before_id')) return [event(70)];
    return initial;
  });
  await render(<ActivityPage ctx={context()} />);
  await click(t('activity.older'));
  expect(request.mock.calls.some(([path]) => path.includes('before_id=71'))).toBe(true);
  expect(container.textContent).toContain('train-70');
  await act(async () => vi.advanceTimersByTime(15000));
  expect(container.textContent).toContain(t('activity.new', { count: '1' }));
  expect(container.textContent).not.toContain('train-101');
  request.mockResolvedValue([event(101), ...initial]);
  await click(t('activity.new', { count: '1' }));
  expect(container.textContent).toContain('train-101');
});

it('restores URL filters, debounces search, and ignores obsolete requests', async () => {
  window.history.replaceState(null, '', '/#/activity?type=failed&range=7d&q=old&job_filter=a%3A1');
  let resolve!: (rows: DeckEvent[]) => void;
  request.mockImplementation(
    () =>
      new Promise<DeckEvent[]>((done) => {
        resolve = done;
      }),
  );
  await render(<ActivityPage ctx={context()} />);
  const old = resolve;
  expect(request.mock.calls[0][0]).toContain('category=failed');
  expect(request.mock.calls[0][0]).toContain('range=7d');
  expect(request.mock.calls[0][0]).toContain('job=a%3A1');
  await act(async () => setRouteParams({ q: 'new' }));
  expect(request.mock.calls.some(([path]) => path.includes('q=new'))).toBe(false);
  request.mockResolvedValue([event(2)]);
  await act(async () => vi.advanceTimersByTime(250));
  expect(request.mock.calls.at(-1)![0]).toContain('q=new');
  await act(async () => old([event(1)]));
  expect(container.textContent).toContain('train-2');
  expect(container.textContent).not.toContain('train-1');
});

it.each(['older', 'reload'] as const)(
  'keeps controls usable during a poll and honors a concurrent %s action',
  async (mode) => {
    const initial = Array.from({ length: 30 }, (_, i) => event(100 - i));
    request.mockResolvedValue(initial);
    await render(<ActivityPage ctx={context()} />);
    request.mockResolvedValue([event(101)]);
    await act(async () => vi.advanceTimersByTime(15000));
    let resolvePoll!: (rows: DeckEvent[]) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<DeckEvent[]>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    await act(async () => vi.advanceTimersByTime(15000));
    const label = mode === 'older' ? t('activity.older') : t('activity.new', { count: '1' });
    for (const text of [t('activity.older'), t('activity.new', { count: '1' })]) {
      const button = [...container.querySelectorAll('button')].find(
        (item) => item.textContent === text,
      );
      expect(button?.disabled).toBe(false);
    }
    let resolveAction!: (rows: DeckEvent[]) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<DeckEvent[]>((resolve) => {
          resolveAction = resolve;
        }),
    );
    await click(label);
    expect(request.mock.calls.at(-1)![0]).not.toContain('after_id=');
    if (mode === 'older') expect(request.mock.calls.at(-1)![0]).toContain('before_id=71');
    await act(async () => resolvePoll([event(102)]));
    expect(
      [...container.querySelectorAll('button')].find(
        (item) => item.textContent === t('common.loading'),
      )?.disabled,
    ).toBe(true);
    await act(async () => resolveAction([event(mode === 'older' ? 70 : 101)]));
    expect(container.textContent).toContain(mode === 'older' ? 'train-70' : 'train-101');
    expect(container.textContent).not.toContain('train-102');
    expect(container.textContent).not.toContain(t('activity.new', { count: '1' }));
  },
);

it.each(['en', 'zh-CN'] as const)('orders day headings by event date in %s', async (language) => {
  setLocale(language);
  const older = { ...event(11), at: new Date(2026, 9, 20, 23, 58).toISOString() };
  const newer = { ...event(10), at: new Date(2026, 9, 21, 0, 2).toISOString() };
  request.mockResolvedValue([older, newer]);
  await render(<ActivityPage ctx={context()} />);
  const sections = [...container.querySelectorAll('.activity-day')].map(
    (item) => item.parentElement!,
  );
  expect(sections).toHaveLength(2);
  expect(sections[0].textContent).toContain('train-10');
  expect(sections[1].textContent).toContain('train-11');
});

it.each(['en', 'zh-CN'] as const)(
  'shares search focus, clear and the length cap in %s',
  async (language) => {
    setLocale(language);
    await act(async () => setRouteParams({ q: 'train' }));
    request.mockResolvedValue([]);
    const ctx = context();
    await render(<ActivityPage ctx={ctx} />);
    const input = container.querySelector('input')!;
    expect(ctx.searchRef.current).toBe(input);
    expect(input.maxLength).toBe(64);
    expect(input.value).toBe('train');
    ctx.searchRef.current!.focus();
    expect(document.activeElement).toBe(input);
    const clear = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('search.clear')}"]`,
    )!;
    await act(async () => clear.click());
    expect(input.value).toBe('');
    expect(window.location.hash).toBe('#/activity');
    await act(async () => vi.advanceTimersByTime(250));
    expect(request.mock.calls.at(-1)![0]).not.toContain('q=');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'expands recorded facts and opens live or historical jobs in %s',
  async (language) => {
    setLocale(language);
    const ctx = context();
    const row = event(1);
    delete row.data.job!.elapsed;
    request.mockResolvedValue([row]);
    await render(<ActivityPage ctx={ctx} />);
    const summary = container.querySelector('summary')!;
    await act(async () => summary.click());
    expect(container.textContent).toContain('1:0');
    expect(container.textContent).toContain('gpu-1');
    expect([...container.querySelectorAll('dt')].map((item) => item.textContent)).not.toContain(
      t('jobs.col.elapsed'),
    );
    expect(container.querySelector('time')?.title).toBeTruthy();
    expect(container.querySelector('a')?.getAttribute('href')).toContain(
      'job_filter=example%3Acluster-b%3A1',
    );
    await click(t('activity.openSnapshot'));
    expect(ctx.openEvent).toHaveBeenCalledWith(row);
    ctx.data.jobs.push({ ...ctx.data.jobs[0], id: row.data.job!.id!, source_id: row.source_id! });
    await render(<ActivityPage ctx={ctx} />);
    await click(t('activity.openJob'));
    expect(ctx.openJob).toHaveBeenCalled();
    await click(t('activity.openSource'));
    expect(ctx.diagnose).toHaveBeenCalledWith(
      ctx.data.sources.find((source) => source.id === row.source_id),
    );
  },
);

it('shows explicit initial loading, filtered and empty states', async () => {
  request.mockImplementation(() => new Promise(() => {}));
  await render(<ActivityPage ctx={context()} />);
  expect(container.textContent).toContain(t('common.loading'));
  request.mockResolvedValue([]);
  await act(async () => setRouteParams({ type: 'plugins' }));
  expect(container.textContent).toContain(t('activity.filtered'));
  const buttons = [...container.querySelectorAll('button')].filter(
    (item) => item.textContent === t('activity.clear'),
  );
  await act(async () => buttons.at(-1)!.click());
  expect(container.textContent).toContain(t('activity.empty24h'));
  await click(t('activity.show30d'));
  expect(container.textContent).toContain(t('activity.empty'));
});

it('keeps per-viewer seen state only after an explicit mark and adds no timer poll', async () => {
  request.mockImplementation(async (path) => (path.includes('after_id=5') ? [] : [event(5)]));
  const ctx = context();
  await render(<ActivityTeaser ctx={ctx} />);
  expect(container.querySelector('h2')?.textContent).toBe(t('activity.title'));
  expect(localStorage.getItem('computedeck.activity.seen')).toBeNull();
  const count = request.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(60000));
  expect(request.mock.calls.length).toBe(count);
  await click(t('activity.markSeen'));
  expect(localStorage.getItem('computedeck.activity.seen')).toBe('5');
  expect(container.querySelector('h2')?.textContent).toBe(t('activity.sinceSeen'));
  expect(container.textContent).toContain(t('activity.seenEmpty'));
});

it('hides seen state when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  request.mockResolvedValue([event(1)]);
  await render(<ActivityTeaser ctx={context()} />);
  expect(container.textContent).not.toContain(t('activity.sinceSeen'));
  expect(container.textContent).not.toContain(t('activity.markSeen'));
  expect(container.textContent).toContain('train-1');
});

it.each(['en', 'zh-CN'] as const)(
  'shows five teaser rows in severity order, newest id first within each priority in %s',
  async (language) => {
    setLocale(language);
    const rows: DeckEvent[] = [
      { ...event(10), type: 'job.started', at: '2026-10-20T13:00:00Z' },
      { ...event(9), type: 'change.source', data: { action: 'edited', name: 'Cluster C' } },
      { ...event(8), type: 'source.recovered', data: { source_name: 'Cluster B' } },
      {
        ...event(7),
        type: 'source.failed',
        at: '2026-10-19T12:00:00Z',
        data: { source_name: 'Cluster A' },
      },
      // Failure priority wins over newer recoveries, starts and changes.
      { ...event(3), at: '2026-10-20T12:00:00Z' },
      { ...event(2), type: 'job.started' },
      { ...event(1), type: 'job.started' },
    ];
    request.mockResolvedValue(rows);
    await render(<ActivityTeaser ctx={context()} />);
    const rendered = [...container.querySelectorAll('.activity > li')];
    expect(rendered).toHaveLength(5);
    const labels = ['Cluster A', 'train-3', 'Cluster B', 'train-10', 'Cluster C'];
    for (const [index, label] of labels.entries()) {
      expect(rendered[index].textContent).toContain(label);
    }
    expect(rendered.map((row) => row.querySelector('.dot')?.className)).toEqual([
      'dot red',
      'dot red',
      'dot green',
      'dot green',
      'dot gray',
    ]);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'omits the teaser loading note after an initial error in %s',
  async (language) => {
    setLocale(language);
    request.mockRejectedValue(new Error('offline'));
    await render(<ActivityTeaser ctx={context()} />);
    expect(container.textContent).toContain(t('activity.error'));
    expect(container.querySelector('.panel-note:not([role="alert"])')).toBeNull();
  },
);

it.each(['en', 'zh-CN'] as const)(
  'hides legacy endings across days and in the teaser while preserving other sources in %s',
  async (language) => {
    setLocale(language);
    const rows: DeckEvent[] = [
      event(4),
      { ...event(3), type: 'job.failed', at: new Date(2026, 9, 20, 12).toISOString() },
      { ...event(2), type: 'job.ended', at: new Date(2026, 9, 19, 12).toISOString() },
      { ...event(1), type: 'job.failed', source_id: 'other-source' },
    ];
    request.mockResolvedValue(rows);
    await render(<ActivityPage ctx={context()} />);
    expect(container.querySelectorAll('.activity-day')).toHaveLength(1);
    for (const view of [<ActivityPage ctx={context()} />, <ActivityTeaser ctx={context()} />]) {
      await render(view);
      expect(container.querySelectorAll('.activity > li')).toHaveLength(2);
      expect(container.textContent).toContain('train-4');
      expect(container.textContent).toContain('train-1');
      expect(container.textContent).not.toContain('train-3');
      expect(container.textContent).not.toContain('train-2');
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'labels job history with the local id while keeping its full address in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue([]);
    const job = 'example:cluster-b:48217';
    await act(async () => setRouteParams({ job_filter: job }));
    await render(<ActivityPage ctx={context()} />);
    expect(container.textContent).toContain(t('activity.forJob', { job: '48217' }));
    expect(container.textContent).not.toContain(job);
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('job_filter')).toBe(job);
    expect(new URLSearchParams(request.mock.calls.at(-1)![0].split('?')[1]).get('job')).toBe(job);
  },
);

it('hides seen controls after a failed storage write and never reads or writes them in example mode', async () => {
  request.mockResolvedValue([event(1)]);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full');
  });
  await render(<ActivityTeaser ctx={context()} />);
  await click(t('activity.markSeen'));
  expect(container.textContent).not.toContain(t('activity.sinceSeen'));
  const read = vi.spyOn(Storage.prototype, 'getItem');
  const write = vi.spyOn(Storage.prototype, 'setItem');
  read.mockClear();
  write.mockClear();
  await render(<ActivityTeaser key="demo" ctx={{ ...context(), demo: true }} />);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain(t('activity.markSeen'));
});

it.each(['en', 'zh-CN'] as const)(
  'distinguishes empty time ranges without user filters in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue([]);
    const ctx = context();
    await render(<ActivityPage ctx={ctx} />);
    for (const range of ['24h', '7d', '30d']) {
      await act(async () => setRouteParams({ range: range === '24h' ? null : range, event: '42' }));
      expect(container.textContent).toContain(
        t(
          range === '30d'
            ? 'activity.empty'
            : range === '7d'
              ? 'activity.empty7d'
              : 'activity.empty24h',
        ),
      );
      expect(container.textContent).not.toContain(t('activity.filtered'));
      const clear = [...container.querySelectorAll('button')].filter(
        (button) => button.textContent === t('activity.clear'),
      );
      expect(clear).toHaveLength(range === '24h' ? 0 : 1);
      if (range !== '30d') {
        await click(t('activity.show30d'));
        expect(window.location.hash).toBe('#/activity?event=42&range=30d');
        expect(container.textContent).toContain(t('activity.empty'));
      } else {
        expect(container.textContent).not.toContain(t('activity.show30d'));
      }
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'uses the same Clear filters action in both locations in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue([]);
    const ctx = { ...context(), group: 'example:cluster-b' };
    const filters = {
      type: 'failed',
      q: 'train',
      job_filter: 'example:cluster-b:1',
      group: ctx.group,
      range: '7d',
    };
    await act(async () => setRouteParams(filters));
    await render(<ActivityPage ctx={ctx} />);
    for (const index of [0, 1]) {
      await act(async () => setRouteParams(filters));
      await act(async () => vi.advanceTimersByTime(250));
      expect(container.textContent).toContain(t('activity.filtered'));
      expect(container.textContent).not.toContain(t('activity.show30d'));
      const controls = [...container.querySelectorAll('button')].filter(
        (button) => button.textContent === t('activity.clear'),
      );
      expect(controls).toHaveLength(2);
      await act(async () => controls[index].click());
      await act(async () => vi.advanceTimersByTime(250));
      expect(window.location.hash).toBe('#/activity');
      expect(new URLSearchParams(request.mock.calls.at(-1)![0].split('?')[1]).get('range')).toBe(
        '24h',
      );
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'only describes an empty teaser as seen after a real mark in %s',
  async (language) => {
    setLocale(language);
    request.mockResolvedValue([]);
    const ctx = context();
    await render(<ActivityTeaser ctx={ctx} />);
    expect(container.querySelector('h2')?.textContent).toBe(t('activity.title'));
    expect(container.textContent).toContain(t('activity.empty'));
    expect(container.textContent).not.toContain(t('activity.seenEmpty'));
    request.mockImplementation(async (path) => (path.includes('after_id=5') ? [] : [event(5)]));
    await render(<ActivityTeaser ctx={{ ...ctx, data: { ...ctx.data, token: 'changed' } }} />);
    await click(t('activity.markSeen'));
    expect(container.textContent).toContain(t('activity.seenEmpty'));
    expect(container.querySelector('h2')?.textContent).toBe(t('activity.sinceSeen'));
    expect(localStorage.getItem('computedeck.activity.seen')).toBe('5');
    // A fresh mount restores the same wording from the stored cursor.
    await render(<ActivityTeaser key="reopened" ctx={ctx} />);
    expect(container.textContent).toContain(t('activity.seenEmpty'));
  },
);

it.each(['en', 'zh-CN'] as const)(
  'formats expanded end times and hides internal event types in %s',
  async (language) => {
    setLocale(language);
    const ctx = context();
    for (const [index, end] of ['2026-10-21T16:52:00+00:00', '2026-10-21T16:52:00'].entries()) {
      const row = event(1);
      row.data.ended_at = index === 0 ? end : null;
      row.data.job!.end = end;
      request.mockResolvedValue([row]);
      await render(<ActivityPage key={end} ctx={ctx} />);
      await act(async () => container.querySelector('summary')!.click());
      const facts = container.querySelector('.activity-details')!;
      expect(facts.textContent).not.toContain('job.finished');
      const ended = [...facts.querySelectorAll('dl > div')].find(
        (item) => item.querySelector('dt')?.textContent === t('jobs.col.ended'),
      )!;
      expect(ended.querySelector('dd')!.textContent).toBe(
        index === 0 ? dateTime(end) : jobTime(end),
      );
      if (index === 0) expect(facts.textContent).not.toContain(end);
      else expect(ended.textContent).toContain(t('job.schedulerTime', { time: end }));
    }
  },
);
