// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import { setLocale, t } from './i18n';
import { jobReason, jobWaiting } from './jobFacts';
import { relativeTime } from './domain';
import { serverDashboard, serverDemo } from './test-server';
import { routeParams, setRouteParams } from './useRouteParam';
import type { Dashboard } from './types';

vi.mock('./api', () => ({ api: vi.fn(), upload: vi.fn(), download: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
let data: Dashboard;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  setLocale('en');
  data = serverDemo();
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language: 'en' };
      if (path === '/health') return null;
      return [];
    });
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
async function render(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<App />));
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps connection and example-mode parameters while replacing view filters', () => {
  window.history.replaceState(
    null,
    '',
    '/?remote=1&device=example&demo=true#/jobs?group=a&state=pending',
  );
  const length = window.history.length;
  setRouteParams({ q: 'two words & more' });
  expect(window.location.search).toBe('?remote=1&device=example&demo=true');
  expect(routeParams().get('q')).toBe('two words & more');
  expect(routeParams().get('group')).toBe('a');
  expect(routeParams().get('state')).toBe('pending');
  expect(window.history.length).toBe(length);
});

it('restores job filters from a link and reacts to browser history changes', async () => {
  await render('/#/jobs?state=pending&q=training');
  expect(container.querySelector<HTMLInputElement>('.search input')?.value).toBe('training');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
    t('status.PENDING'),
  );
  await act(async () => {
    window.history.replaceState(null, '', '/#/jobs?state=running&q=another');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(container.querySelector<HTMLInputElement>('.search input')?.value).toBe('another');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
    t('status.RUNNING'),
  );
  await input(container.querySelector<HTMLInputElement>('.search input')!, 'new query');
  expect(routeParams().get('q')).toBe('new query');
  expect(routeParams().get('state')).toBe('running');
});

it('restores and updates planner inputs without losing its requested GPU model', async () => {
  await render('/?demo=true#/plan?gpus=4&model=unlisted-model&hours=12');
  const numbers = container.querySelectorAll<HTMLInputElement>('.plan-form input');
  expect(numbers[0].value).toBe('4');
  expect(numbers[1].value).toBe('12');
  expect(container.querySelector<HTMLSelectElement>('.plan-form select')?.value).toBe(
    'unlisted-model',
  );
  await input(numbers[0], '8');
  await input(numbers[1], '24');
  expect(routeParams().get('gpus')).toBe('8');
  expect(routeParams().get('hours')).toBe('24');
  expect(routeParams().get('model')).toBe('unlisted-model');
  expect(window.location.search).toBe('?demo=true');
});

it('uses safe planner defaults for invalid values in a link', async () => {
  await render('/#/plan?gpus=Infinity&hours=-2');
  const numbers = container.querySelectorAll<HTMLInputElement>('.plan-form input');
  expect(numbers[0].value).toBe('1');
  expect(numbers[1].value).toBe('');
});

it('opens a job by URL, keeps it current, and explains when it leaves the data', async () => {
  const job = data.jobs[0];
  await render(`/?demo=true#/jobs?job=${encodeURIComponent(job.id)}`);
  expect(container.querySelector('#detail-title')?.textContent).toBe(job.name);
  data = {
    ...data,
    jobs: data.jobs.map((row) => (row.id === job.id ? { ...row, name: 'Updated job' } : row)),
  };
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.querySelector('#detail-title')?.textContent).toBe('Updated job');
  data = { ...data, jobs: data.jobs.filter((row) => row.id !== job.id) };
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.querySelector('#detail-title')?.textContent).toBe(t('drawer.unavailable'));
  expect(vi.mocked(api).mock.calls.some(([, body]) => body !== undefined)).toBe(false);
});

it('opens instance details in history and closes them when navigating back', async () => {
  await render('/?demo=true#/cloud');
  const length = window.history.length;
  await act(async () => container.querySelector<HTMLElement>('.clickable')!.click());
  expect(routeParams().get('instance')).toBe(data.instances[0].id);
  expect(window.history.length).toBe(length + 1);
  await act(async () => {
    window.history.replaceState(null, '', '/?demo=true#/cloud');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('links to a failed attempt separately from the current job list', async () => {
  const failed = data.recent_failures![0];
  await render(`/?demo=true#/jobs?state=failed&failure=${encodeURIComponent(failed.id)}`);
  expect(container.querySelector('#detail-title')?.textContent).toBe(failed.name);
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(t('job.nextStep'));
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain(failed.exit_code!);
});

it('uses the same deduplicated job record in the list and detail', async () => {
  const job = data.jobs[0];
  data = { ...data, jobs: [...data.jobs, { ...job, name: 'Current observation' }] };
  await render(`/?demo=true#/jobs?job=${encodeURIComponent(job.id)}`);
  expect(container.querySelector('#detail-title')?.textContent).toBe('Current observation');
});

it.each(['en', 'zh-CN'] as const)(
  'opens arrays by keyboard and lists 50 elements at a time in %s',
  async (language) => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/dashboard')) return data;
      if (path === '/settings') return { language };
      return [];
    });
    const example = data.jobs.find((item) => item.array_id)!;
    data = serverDashboard({
      ...data,
      jobs: Array.from({ length: 110 }, (_, index) => ({
        ...example,
        id: `${example.cluster_id}:48300_${index}`,
        array_index: String(index),
      })),
    });
    await render('/?demo=true#/jobs');
    expect(container.querySelectorAll('.jobs-table tbody tr')).toHaveLength(1);
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () =>
      container
        .querySelector('.array-row')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(routeParams().get('array')).toBe(`${example.cluster_id}:48300`);
    expect(routeParams().get('job')).toBeNull();
    expect(push).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.drawer-kind')?.textContent).toBe(t('drawer.array'));
    expect(container.querySelectorAll('.drawer .array-elements-table tbody tr')).toHaveLength(50);
    const table = container.querySelector<HTMLTableElement>('.drawer .array-elements-table')!;
    expect(table.classList.contains('stack-on-phone')).toBe(true);
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      t('jobs.array.element'),
      t('jobs.col.state'),
      'GPU',
      t('jobs.col.nodeReason'),
      t('jobs.col.timing'),
    ]);
    for (const row of table.tBodies[0].rows) {
      expect(row.cells).toHaveLength(5);
      expect(row.cells[0].hasAttribute('data-label')).toBe(false);
      expect([...row.cells].slice(1).every((cell) => cell.hasAttribute('data-label'))).toBe(true);
      expect(row.tabIndex).toBe(0);
      expect(row.textContent).not.toContain(example.name);
      expect(row.textContent).not.toContain(example.gpu_type);
    }
    expect(table.tBodies[0].rows[0].cells[0].querySelector('strong')?.textContent).toBe('0');
    expect(table.tBodies[0].rows[0].cells[0].querySelector('.sub.mono')?.textContent).toBe(
      data.jobs[0].id,
    );
    const facts = [...container.querySelectorAll('.drawer .kv dd')].map((cell) => cell.textContent);
    expect(facts).toEqual(['Cluster A', example.user, example.qos, example.partition]);

    const button = (key: 'jobs.array.showMore' | 'jobs.array.showAll') =>
      [...container.querySelectorAll<HTMLButtonElement>('.drawer button')].find(
        (item) => item.textContent === t(key),
      )!;
    await act(async () => button('jobs.array.showMore').click());
    expect(container.querySelectorAll('.drawer .array-elements-table tbody tr')).toHaveLength(100);
    await act(async () => button('jobs.array.showAll').click());
    expect(container.querySelectorAll('.drawer .array-elements-table tbody tr')).toHaveLength(110);
    await act(async () => container.querySelector<HTMLElement>('.drawer .clickable')!.click());
    expect(routeParams().get('job')).toBe(data.jobs[0].id);
    expect(routeParams().get('array')).toBeNull();
    expect(container.querySelector('.drawer-kind')?.textContent).toBe(t('drawer.job'));
    await act(async () => {
      window.history.back();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(routeParams().get('array')).toBe(`${example.cluster_id}:48300`);
    expect(container.querySelector('.drawer-kind')?.textContent).toBe(t('drawer.array'));
    await act(async () =>
      container
        .querySelector('.drawer .clickable')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(routeParams().get('job')).toBe(data.jobs[0].id);
  },
);

it('restores the array drawer, follows live membership, and explains a missing array', async () => {
  const example = data.jobs.find((item) => item.array_id)!;
  const arrayId = `${example.cluster_id}:${example.array_id}`;
  await render(`/?demo=true#/jobs?state=pending&q=unmatched&array=${encodeURIComponent(arrayId)}`);
  expect(container.querySelectorAll('.drawer .array-elements-table tbody tr')).toHaveLength(30);
  data = serverDashboard({ ...data, jobs: [{ ...example, name: 'Updated sweep' }] });
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.querySelectorAll('.drawer .array-elements-table tbody tr')).toHaveLength(1);
  expect(container.querySelector('#detail-title')?.textContent).toContain('Updated sweep');
  data = serverDashboard({ ...data, jobs: [] });
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.querySelector('#detail-title')?.textContent).toBe(t('drawer.unavailable'));
  expect(vi.mocked(api).mock.calls.every(([, body]) => body === undefined)).toBe(true);
});

it('keeps tab and navigation counts in elements when the Jobs table groups arrays', async () => {
  const example = data.jobs.find((item) => item.array_id)!;
  data = serverDashboard({
    ...data,
    sources: data.sources.filter((item) => item.id === example.source_id),
    jobs: Array.from({ length: 3 }, (_, index) => ({
      ...example,
      id: `${example.cluster_id}:48300_${index}`,
      state: index === 2 ? 'PENDING' : 'RUNNING',
    })),
  });
  await render('/?demo=true#/jobs?state=pending');
  expect(container.querySelector('.jobs-table .array-row')).toBeNull();
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    `${t('status.PENDING')}1`,
  );
  expect(container.querySelector('a[href="#/jobs"] .badge')?.textContent).toBe('3');
  await act(async () => setRouteParams({ state: 'running' }));
  expect(container.querySelectorAll('.jobs-table .array-row')).toHaveLength(1);
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    `${t('status.RUNNING')}2`,
  );
});

it('keeps ordinary and array card titles unlabelled while labelling their facts', async () => {
  await render('/?demo=true#/jobs');
  const rows = [...container.querySelectorAll<HTMLTableRowElement>('.jobs-table tbody tr')];
  expect(rows.some((row) => row.classList.contains('array-row'))).toBe(true);
  expect(rows.some((row) => !row.classList.contains('array-row'))).toBe(true);
  for (const row of rows) {
    expect(row.cells[0].hasAttribute('data-label')).toBe(false);
    expect(row.cells[0].querySelector('strong')?.textContent).toBeTruthy();
    expect([...row.cells].slice(1).every((cell) => cell.hasAttribute('data-label'))).toBe(true);
  }
});

it('keeps compact element resources, waiting reasons and stale tags', async () => {
  const example = data.jobs.find((item) => item.array_id)!;
  const pending = {
    ...example,
    id: `${example.cluster_id}:48300_31`,
    array_index: '31',
    state: 'PENDING',
    gpu_count: null,
    reason: 'Resources',
  };
  data = serverDashboard({
    ...data,
    sources: data.sources.map((item) =>
      item.id === example.source_id ? { ...item, stale: true } : item,
    ),
    jobs: [example, pending],
  });
  await render(
    `/?demo=true#/jobs?array=${encodeURIComponent(`${example.cluster_id}:${example.array_id}`)}`,
  );
  const rows = [
    ...container.querySelectorAll<HTMLTableRowElement>('.drawer .array-elements-table tbody tr'),
  ];
  expect(rows).toHaveLength(2);
  expect(rows[0].cells[2].textContent).toBe(String(example.gpu_count));
  expect(rows[0].cells[3].textContent).toBe(example.node);
  expect(rows[0].cells[4].textContent).toBe(example.elapsed);
  expect(rows[1].cells[2].textContent).toBe(t('jobs.requested', { count: '?' }));
  expect(rows[1].cells[3].textContent).toBe(jobReason(pending, 'slurm')!.summary);
  expect(rows[1].cells[4].textContent).toBe(jobWaiting(pending));
  for (const row of rows) {
    expect(row.classList.contains('stale-row')).toBe(true);
    expect(row.cells[0].textContent).toContain(
      t('cloud.staleSince', { time: relativeTime(example.observed_at) }),
    );
  }
});
