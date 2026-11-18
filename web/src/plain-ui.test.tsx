// @vitest-environment jsdom
// Guards the plain visual language: no identity tiles, no icons beside button words, no
// headings or tags that restate what the layout already shows.
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupsOf } from './groups';
import { setLocale } from './i18n';
import { CloudPage } from './pages/Cloud';
import { ClustersPage } from './pages/Clusters';
import { OverviewPage } from './pages/Overview';
import { PlanPage } from './pages/Plan';
import { SourcesPage } from './pages/Sources';
import { UsagePage } from './pages/Usage';
import type { Ctx } from './pages/shared';
import { serverDemo } from './test-server';
import type { Dashboard } from './types';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(async (path: string) =>
    path.startsWith('/history') ? { rollups: { end: new Date().toISOString(), buckets: [] } } : [],
  ),
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
    locale: 'en',
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
    collect: vi.fn(),
    copy: vi.fn(),
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

const pages: [string, (ctx: Ctx) => ReactNode][] = [
  ['Overview', (ctx) => <OverviewPage ctx={ctx} />],
  ['Clusters', (ctx) => <ClustersPage ctx={ctx} />],
  ['Cloud', (ctx) => <CloudPage ctx={ctx} />],
  ['Where to run', (ctx) => <PlanPage ctx={ctx} />],
  ['Usage', (ctx) => <UsagePage ctx={ctx} />],
  ['Sources', (ctx) => <SourcesPage ctx={ctx} />],
];

describe.each(['en', 'zh-CN'] as const)('plain interface in %s', (locale) => {
  it.each(pages)('%s has no identity tiles and no icon beside a button word', async (_, page) => {
    setLocale(locale);
    await show(page(context(serverDemo())));
    // Names stand alone: no coloured monogram tile in tables, cards or headers. The frozen
    // RankedBars kit still renders its mark; styles.css hides it there.
    expect(host.querySelector('.provider-mark:not(.ranked-bars *)')).toBeNull();
    // An icon stays only when it is the control itself: worded buttons and links carry none.
    const worded = [...host.querySelectorAll('.button, .link, .primary-button')].filter((control) =>
      control.textContent?.trim(),
    );
    for (const control of worded) expect(control.querySelector('svg.lucide')).toBeNull();
    // Section headings name the section; a count appears only as a partial-count trigger.
    for (const count of host.querySelectorAll('.panel-header h2 .count'))
      expect(count.querySelector('button.partial')).not.toBeNull();
  });

  it('shows estimates without an Estimate tag where every figure is one', async () => {
    setLocale(locale);
    for (const [, page] of pages.filter(([name]) => ['Where to run', 'Usage'].includes(name))) {
      await show(page(context(serverDemo())));
      for (const tag of host.querySelectorAll('.panel-header .tag'))
        expect(['Estimate', '估算']).not.toContain(tag.textContent);
    }
  });
});
