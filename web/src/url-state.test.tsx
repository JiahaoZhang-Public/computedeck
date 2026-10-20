// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import { setLocale, t } from './i18n';
import { serverDemo } from './test-server';
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
