// @vitest-environment jsdom
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobCount } from './domain';
import { groupsOf } from './groups';
import { formatMessage, setLocale, t } from './i18n';
import { CloudPage } from './pages/Cloud';
import { OverviewPage } from './pages/Overview';
import type { Ctx } from './pages/shared';
import { serverDemo } from './test-server';
import type { Dashboard } from './types';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(async () => []),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setLocale('en');
});

function context(data: Dashboard) {
  return {
    data,
    groups: groupsOf(data),
    demo: false,
    group: 'all',
    query: '',
    attention: [],
    webPlugins: [],
    tools: [],
    drivers: [],
    nodes: [],
    plugin: {},
    searchRef: { current: null },
    setGroup: vi.fn(),
    setQuery: vi.fn(),
    navigate: vi.fn(),
    openJob: vi.fn(),
    openArray: vi.fn(),
    openEvent: vi.fn(),
    openInstance: vi.fn(),
    openAttention: vi.fn(),
    diagnose: vi.fn(),
    configure: vi.fn(),
    reload: vi.fn(),
    notify: vi.fn(),
  } as unknown as Ctx;
}

async function show(node: ReactNode) {
  await act(async () => root.render(node));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/**
 * The partial number itself is the trigger: its text is the number alone, and what it does not
 * count is only its accessible name and tooltip, never a visible caption.
 */
function expectPartial(button: HTMLButtonElement | null | undefined, what: string) {
  expect(button).toBeTruthy();
  expect(button!.matches('button.partial')).toBe(true);
  const value = button!.textContent!;
  expect(value).toMatch(/^≥ /);
  expect(button!.getAttribute('aria-label')).toBe(`${value}, ${what}`);
  expect(button!.getAttribute('title')).toBe(what);
  return value;
}

/** Visible page text: attributes such as aria-label and title are not part of it. */
function expectNotVisible(what: string) {
  expect(document.body.textContent).not.toContain(what);
}

/** Open a marker and return its list; the list loads with the first opening. */
async function open(marker: HTMLButtonElement | null | undefined) {
  expect(marker).toBeTruthy();
  expect(marker!.getAttribute('aria-haspopup')).toBe('dialog');
  expect(marker!.getAttribute('aria-expanded')).toBe('false');
  await act(async () => marker!.click());
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(marker!.getAttribute('aria-expanded')).toBe('true');
  const list = document.querySelector<HTMLElement>('.unmeasured-list');
  expect(list).not.toBeNull();
  return list!;
}

const tile = (label: string) =>
  [...host.querySelectorAll('.stat')].find(
    (stat) => stat.querySelector('.stat-label')?.textContent === label,
  )!;

describe.each(['en', 'zh-CN'] as const)('quiet markers in %s', (locale) => {
  it('keeps a partial total as one marker that lists every unmeasured subject', async () => {
    setLocale(locale);
    const data = serverDemo();
    const ctx = context(data);
    await show(<OverviewPage ctx={ctx} />);
    const { unmeasured, unmonitored } = data.summary;
    expect(unmeasured.length).toBeGreaterThan(2);
    expect(unmonitored).toBeGreaterThan(0);
    const allocated = tile(t('overview.allocated'));
    // The lower bound stays on the number, and the number itself opens what it does not count.
    const what = t('unmeasured.count', { count: unmeasured.length + unmonitored });
    expect(allocated.querySelector('.stat-value')!.textContent).toMatch(/^≥ \d+$/);
    const trigger = allocated.querySelector<HTMLButtonElement>('.stat-value button');
    expect(expectPartial(trigger, what)).toBe(allocated.querySelector('.stat-value')!.textContent);
    expect(allocated.querySelector('.stat-hint')).toBeNull();
    expectNotVisible(what);
    const list = await open(trigger);
    const entries = [...list.querySelectorAll('li')];
    expect(entries.map((entry) => entry.textContent)).toEqual(
      unmeasured.map(({ subject, reason }) => `${subject.name}${formatMessage(reason)}`),
    );
    expect(list.querySelector('p')!.textContent).toBe(
      t('summary.unmonitored', { count: unmonitored }),
    );
    // Each entry still opens its machine or its diagnosis, and the list closes first.
    const machine = unmeasured.findIndex((item) => item.subject.kind === 'instance');
    await act(async () => entries[machine].querySelector('button')!.click());
    expect(document.querySelector('.unmeasured-list')).toBeNull();
    expect(ctx.openInstance).toHaveBeenCalledWith(
      data.instances.find((item) => item.id === unmeasured[machine].subject.id),
    );
    // Focus goes back to the number, so the detail opened next returns there.
    expect(document.activeElement).toBe(trigger);
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    const login = unmeasured.findIndex((item) => item.subject.kind === 'source');
    const again = await open(trigger);
    await act(async () => again.querySelectorAll('button')[login].click());
    expect(ctx.diagnose).toHaveBeenCalledWith(
      data.sources.find((item) => item.id === unmeasured[login].subject.id),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves complete totals without any caption', async () => {
    setLocale(locale);
    const data = serverDemo();
    data.summary.running = 8;
    data.summary.requested = 42;
    await show(<OverviewPage ctx={context(data)} />);
    for (const label of [t('overview.queued'), t('overview.running')]) {
      expect(tile(label).querySelector('.stat-hint')).toBeNull();
      // A complete number is just the number: no trigger and no lower bound.
      expect(tile(label).querySelector('.stat-value button')).toBeNull();
      expect(tile(label).querySelector('.stat-value')!.textContent).toMatch(/^\d+$/);
    }
  });

  it('names logins whose jobs are unknown and explains the last-known rows', async () => {
    setLocale(locale);
    const data = serverDemo();
    await show(<OverviewPage ctx={context(data)} />);
    const missing = data.sources.filter((source) =>
      data.summary.jobs.missing_source_ids.includes(source.id),
    );
    expect(missing.length).toBeGreaterThan(0);
    // The panel's partial job count is the trigger; whose jobs are missing is its name.
    const what = t('jobs.missing.count', { count: missing.length });
    const marker = host.querySelector<HTMLButtonElement>('.panel-header h2 .count button.partial');
    expect(marker).toBeTruthy();
    const count = jobCount(data.summary.jobs.known, data.summary.jobs.missing_source_ids.length);
    expect(marker!.textContent).toBe(String(count));
    expect(marker!.getAttribute('aria-label')).toBe(`${count}, ${what}`);
    expect(marker!.getAttribute('title')).toBe(what);
    expect(host.querySelector('.unmeasured-mark')).toBeNull();
    expectNotVisible(what);
    const list = await open(marker);
    for (const source of missing) expect(list.textContent).toContain(source.name);
    expect(list.querySelector('p')!.textContent).toContain(t('jobs.missing.stale'));
    expect(list.querySelector('p')!.textContent).toContain(
      t('jobs.lastKnownCount', { count: host.querySelectorAll('.jobs-table .stale-row').length }),
    );
  });

  it('does not open a clickable row when its marker is used', async () => {
    setLocale(locale);
    const ctx = context(serverDemo());
    await show(<OverviewPage ctx={ctx} />);
    const marker = host.querySelector<HTMLButtonElement>('tr.clickable button.partial')!;
    expect(marker.textContent).toMatch(/^≥ \d+$/);
    await open(marker);
    marker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ctx.navigate).not.toHaveBeenCalled();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.unmeasured-list button')!.click(),
    );
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('counts unpriced instances beside the spend rate and lists them', async () => {
    setLocale(locale);
    const data = serverDemo();
    const { unpriced } = data.summary.spend!;
    expect(unpriced.length).toBeGreaterThan(0);
    const ctx = context(data);
    await show(<CloudPage ctx={ctx} />);
    // The spend rate is a tile per currency; its lower-bound rate opens the unpriced list.
    const what = t('cost.unpriced', { count: unpriced.length });
    const tiles = [...host.querySelectorAll('.stat')].filter((stat) =>
      stat.querySelector('.stat-label')?.textContent?.startsWith(t('cost.now')),
    );
    expect(tiles.length).toBeGreaterThan(0);
    expectNotVisible(what);
    for (const stat of tiles) {
      const trigger = stat.querySelector<HTMLButtonElement>('.stat-value button');
      const value = expectPartial(trigger, what);
      expect(value).toBe(stat.querySelector('.stat-value')!.textContent);
      expect(stat.querySelector('.stat-hint')).toBeNull();
      const list = await open(trigger);
      for (const { subject } of unpriced) expect(list.textContent).toContain(subject.name);
      // An unpriced machine opens its instance, and focus returns to the rate.
      const machine = unpriced.findIndex((item) => item.subject.kind === 'instance');
      expect(machine).toBeGreaterThanOrEqual(0);
      await act(async () => list.querySelectorAll('button')[machine].click());
      expect(document.querySelector('.unmeasured-list')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(ctx.openInstance).toHaveBeenLastCalledWith(
        data.instances.find((item) => item.id === unpriced[machine].subject.id),
      );
    }
    expect(ctx.openInstance).toHaveBeenCalledTimes(tiles.length);
  });
});
