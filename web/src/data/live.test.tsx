// @vitest-environment jsdom
import { act, Profiler, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { serverDemo } from '../test-server';
import { setLocale, t } from '../i18n';
import { relativeTime } from '../format';
import { money } from '../domain';
import { SourceDiagnosis } from '../SourceDiagnosis';
import { FailuresTable, InstanceRunCost } from '../pages/shared';
import { createLiveStore, share } from './store';
import { transitions } from './transitions';
import { sincePath, tokenOf } from './poll';
import { usePollCadence } from './cadence';
import { ClockText } from './ClockText';
import { useVisibleInterval } from '../useVisibleInterval';

const data = serverDemo();
const snapshot = () => ({
  ...createLiveStore().getSnapshot(),
  data: structuredClone(data),
  loading: false,
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocale('en');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('row sharing', () => {
  it('keeps row identities through changes, reorders and removals, scoped by source', () => {
    const a = { id: '1', source_id: 'cluster-a', rev: 'a1', state: 'RUNNING' };
    const b = { id: '1', source_id: 'cluster-b', rev: 'b1', state: 'PENDING' };
    const previous = [a, b];
    expect(share(previous, structuredClone(previous))).toBe(previous);
    const reorder = share(previous, [structuredClone(b), structuredClone(a)]);
    expect(reorder[0]).toBe(b);
    expect(reorder[1]).toBe(a);
    const changed = share(previous, [a, { ...b, rev: 'b2', state: 'RUNNING' }]);
    expect(changed[0]).toBe(a);
    expect(changed[1]).not.toBe(b);
    expect(share(previous, [structuredClone(b)])[0]).toBe(b);
    expect(share(previous, [])).toEqual([]);
  });
  it('shares nested data without revisions and removes fields without retaining old data', () => {
    const before = {
      rows: [
        { id: 'a', value: [1, 2] },
        { id: 'b', value: [3] },
      ],
      old: true,
    };
    expect(share(before, structuredClone(before))).toBe(before);
    const next = share<object>(before, { rows: [{ id: 'b', value: [3] }] }) as { rows: object[] };
    expect(next.rows[0]).toBe(before.rows[1]);
    expect(next).not.toHaveProperty('old');
  });
  it('publishes once for a changed poll and zero commits for repeated unchanged snapshots', async () => {
    const store = createLiveStore();
    const commits = vi.fn();
    const read = vi.fn();
    function View() {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
      read(state);
      return state.data?.jobs.length;
    }
    await act(async () =>
      root.render(
        <Profiler id="rows" onRender={commits}>
          <View />
        </Profiler>,
      ),
    );
    commits.mockClear();
    await act(async () => store.update(snapshot()));
    expect(commits).toHaveBeenCalledTimes(1);
    const before = store.getSnapshot();
    commits.mockClear();
    for (let i = 0; i < 10; i++) await act(async () => store.update(structuredClone(before)));
    expect(commits).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    const next = structuredClone(before.data!);
    next.jobs[0].state = 'COMPLETED';
    await act(async () => store.update({ data: next }));
    expect(commits).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().data!.jobs[0]).not.toBe(before.data!.jobs[0]);
    expect(store.getSnapshot().data!.jobs[1]).toBe(before.data!.jobs[1]);
    expect(store.getSnapshot().data!.sources).toBe(before.data!.sources);
    expect(read).toHaveBeenCalled();
  });
});

describe.each(['en', 'zh-CN'] as const)('transition announcements in %s', (language) => {
  it('is silent for initial data, timestamp changes, identical states and mode switches', () => {
    setLocale(language);
    const before = snapshot();
    const after = structuredClone(before);
    after.data!.jobs[0].observed_at = '2026-01-15T14:00:00Z';
    after.data!.updated_at = '2026-01-15T14:00:00Z';
    expect(transitions(createLiveStore().getSnapshot(), before, true)).toBe('');
    expect(transitions(before, after, true)).toBe('');
    after.data!.mode = 'live';
    expect(transitions(before, after, false)).toBe('');
  });
  it('announces jobs and attention without inferring an outcome for disappearing jobs', () => {
    setLocale(language);
    const before = snapshot();
    const after = structuredClone(before);
    after.data!.jobs[0].state = 'COMPLETED';
    after.data!.jobs.pop();
    after.data!.attention_count = 1;
    const text = transitions(before, after, true);
    expect(text).toBe(
      [
        t('live.jobsChanged', { count: 1 }),
        t('live.jobsLeft', { count: 1 }),
        t('live.attention', { count: 1 }),
      ].join(language === 'zh-CN' ? '；' : '. '),
    );
    after.data!.jobs.push({ ...after.data!.jobs[0], id: 'new-job' });
    expect(transitions(before, after, true)).toContain(t('live.jobsAdded', { count: 1 }));
  });
  it('is silent when the same job is observed through a different twin login', () => {
    setLocale(language);
    const before = snapshot();
    const after = structuredClone(before);
    after.data.jobs[0].source_id = 'cluster-a-twin';
    expect(transitions(before, after, true)).toBe('');
    after.data.jobs[0].state = 'COMPLETED';
    expect(transitions(before, after, true)).toBe(t('live.jobsChanged', { count: 1 }));
  });
  it('announces a service failure and recovery but not repeated failures', () => {
    setLocale(language);
    const before = snapshot();
    const failed = { ...before, error: 'unreachable' };
    expect(transitions(before, failed, true)).toBe(
      t('live.health', { status: t('health.unreachable') }),
    );
    expect(transitions(failed, { ...failed }, true)).toBe('');
    expect(transitions(failed, before, true)).not.toBe('');
  });
  it('gives health context when authentication makes the status unknown', () => {
    setLocale(language);
    const before = { ...snapshot(), error: 'unreachable' };
    expect(transitions(before, { ...before, needsToken: true }, false)).toBe(
      t('live.health', { status: t('health.unknown') }),
    );
  });
});

it('reads HTTP tokens without changing array JSON or the Request contract', async () => {
  const fetch = vi.fn<typeof window.fetch>(
    async () =>
      new Response('[{"id":"example","rev":"r1"}]', {
        headers: { 'X-ComputeDeck-Since': 'node token' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const rows = await api<object[]>('/nodes?demo=true');
  expect(Array.isArray(rows)).toBe(true);
  expect(JSON.stringify(rows)).toBe('[{"id":"example","rev":"r1"}]');
  expect(tokenOf(rows)).toBe('node token');
  await api(sincePath('/nodes?demo=true', tokenOf(rows)));
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/nodes?demo=true&since=node%20token');
  expect(sincePath('/health', 'next')).toBe('/health?since=next');
  expect(sincePath('/health')).toBe('/health');
});

it('ticks only the age label, leaving its parent and row mounted', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T14:00:00Z'));
  const parent = vi.fn();
  function Row() {
    parent();
    return (
      <p>
        <ClockText>{() => relativeTime('2026-01-15T13:59:00Z')}</ClockText>
      </p>
    );
  }
  await act(async () => root.render(<Row />));
  const row = container.querySelector('p');
  parent.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(container.textContent).toBe(t('time.minutesAgo', { count: 2 }));
  expect(container.querySelector('p')).toBe(row);
  expect(parent).not.toHaveBeenCalled();
});

it('adapts pointer cadence, pauses hidden requests, coalesces return events and cleans up', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const media = new EventTarget() as MediaQueryList;
  Object.defineProperty(media, 'matches', { value: false, writable: true });
  vi.stubGlobal('matchMedia', () => media);
  const poll = vi.fn();
  function Poller() {
    useVisibleInterval(poll, usePollCadence());
    return null;
  }
  await act(async () => root.render(<Poller />));
  expect(poll).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(poll).toHaveBeenCalledTimes(2);
  await act(async () => {
    Object.defineProperty(media, 'matches', { value: true });
    media.dispatchEvent(new Event('change'));
  });
  poll.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(29999));
  expect(poll).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(poll).toHaveBeenCalledTimes(1);
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  poll.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(poll).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  expect(poll).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  poll.mockClear();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    media.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(poll).not.toHaveBeenCalled();
});

it('keeps coarse-pointer WebKit hosts on thirty seconds even with message handlers', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('webkit', { messageHandlers: {} });
  function View() {
    return usePollCadence();
  }
  await act(async () => root.render(<View />));
  expect(container.textContent).toBe('30000');
});

it.each(['en', 'zh-CN'] as const)(
  'updates failure end ages without a poll in %s',
  async (locale) => {
    setLocale(locale);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T14:00:00Z'));
    const job = { ...data.recent_failures![0], ended_at: '2026-01-15T13:57:00Z' };
    await act(async () => root.render(<FailuresTable jobs={[job]} groups={[]} />));
    const cell = container.querySelector('tbody tr td:last-child')!;
    expect(cell.textContent).toBe(t('time.minutesAgo', { count: 3 }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(cell.textContent).toBe(t('time.minutesAgo', { count: 4 }));
  },
);

it('keeps overdue diagnosis text and running-cost estimates advancing without a poll', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T14:00:00Z'));
  const source = {
    ...data.sources[0],
    status: 'ready',
    next_due_at: '2026-01-15T14:00:00Z',
    error: null,
  };
  const cloud = {
    ...data.sources.find((row) => row.kind === 'cloud')!,
    status: 'ready',
    stale: false,
    capabilities: ['instances'],
  };
  const instance = {
    ...data.instances[0],
    state: 'running',
    hourly_cost: 60,
    currency: 'USD',
    started_at: '2026-01-15T13:00:00Z',
  };
  await act(async () =>
    root.render(
      <>
        <SourceDiagnosis source={source} demo drivers={[]} />
        <InstanceRunCost item={instance} source={cloud} />
      </>,
    ),
  );
  expect(container.textContent).not.toContain(t('health.overdueReason'));
  expect(container.textContent).toContain(t('cost.estimate', { cost: money(60, 'USD') }));
  await act(async () => vi.advanceTimersByTimeAsync(180000));
  expect(container.textContent).toContain(t('health.overdueReason'));
  expect(container.textContent).toContain(t('cost.estimate', { cost: money(63, 'USD') }));
});
