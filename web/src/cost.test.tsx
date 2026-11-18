// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dateTime, money, relativeTime, runDuration } from './domain';
import { statusLabel } from './labels';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { CloudPage } from './pages/Cloud';
import { InstanceDetail } from './pages/Details';
import { UsagePage } from './pages/Usage';
import type { Ctx } from './pages/shared';
import { serverDashboard, serverDemo } from './test-server';

let demo: ReturnType<typeof serverDemo>;
beforeAll(() => {
  demo = serverDemo();
});

function fixture() {
  const data = structuredClone(demo);
  const item = data.instances.find((i) => i.name === 'sd-inference')!;
  const source = data.sources.find((s) => s.id === item.source_id)!;
  data.instances = [item];
  data.sources = [source];
  data.jobs = [];
  data.nodes = [];
  item.started_at = '2026-01-01T00:00:00Z';
  item.seen_running_since = '2026-01-01T02:00:00Z';
  source.last_success = '2026-01-01T03:00:00Z';
  data.summary = serverDashboard(data).summary;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T04:00:00Z'));
  const ctx = {
    data,
    groups: groupsOf(data),
    group: 'all',
    query: '',
    demo: true,
    searchRef: { current: null },
    setQuery: vi.fn(),
    setGroup: vi.fn(),
  } as unknown as Ctx;
  const drawer = () =>
    renderToStaticMarkup(
      <InstanceDetail
        item={item}
        ctx={ctx}
        onProbe={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  const cloud = () => renderToStaticMarkup(<CloudPage ctx={ctx} />);
  return { data, item, source, ctx, drawer, cloud };
}
function parse(html: string) {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}
function text(html: string) {
  return parse(html).textContent!;
}
function rowLabel(html: string) {
  return parse(html).querySelector('tbody tr td')!;
}
function firstRow(html: string) {
  return parse(html).querySelector('tbody tr')!;
}
/** One value per cell: the cell of `row` under the column headed `header`. */
function cell(row: Element, header: string) {
  const headers = [...row.closest('table')!.querySelectorAll('thead th')].map(
    (th) => th.textContent,
  );
  expect(headers).toContain(header);
  return row.children[headers.indexOf(header)] as HTMLElement;
}
/** Stat tiles: the label carries the meaning (and the currency), the value only the figure. */
function tiles(html: string) {
  return [...parse(html).querySelectorAll('.stat')].map((stat) => ({
    label: stat.querySelector('.stat-label')!.textContent,
    value: stat.querySelector('.stat-value')!,
  }));
}
function tile(html: string, label: string) {
  return tiles(html).find((item) => item.label === label)?.value;
}
afterEach(() => {
  vi.useRealTimers();
  setLocale('en');
});

describe.each(['en', 'zh-CN'] as const)('cost display in %s', (language) => {
  it('labels provider time, whole-instance and per-GPU prices and estimates on rows and drawers', () => {
    setLocale(language);
    const { drawer, cloud, item } = fixture();
    expect(text(drawer())).toContain(t('cost.perInstance', { price: money(0.69, 'USD') }));
    expect(text(drawer())).toContain(t('cost.perGpu', { price: money(0.345, 'USD') }));
    expect(text(drawer())).toContain(t('cost.since.provider', { time: dateTime(item.started_at) }));
    expect(text(drawer())).toContain(t('cost.estimate', { cost: money(2.76, 'USD') }));
    expect(text(drawer())).toContain(t('cost.runningFor', { duration: runDuration(4) }));
    expect(text(drawer())).toContain(t('cost.excludes'));
    // The row is one line: platform, state and price each get their own column; run time and
    // estimate live in the drawer.
    const row = firstRow(cloud());
    const label = row.querySelector('td')!;
    expect(label.querySelector('.sub')).toBeNull();
    expect(label.querySelector('strong')?.textContent).toBe(item.name);
    expect(cell(row, t('usage.col.platform')).textContent).toBe(item.platform);
    expect(cell(row, t('jobs.col.state')).textContent).toBe(statusLabel('running'));
    expect(label.textContent).not.toContain(`${money(0.69, 'USD')}/h`);
    expect(cell(row, t('cost.price')).textContent).toBe(
      t('usage.hourlyRate', { price: money(0.69, 'USD') }),
    );
    expect(row.textContent).not.toContain(`≈ ${money(2.76, 'USD')}`);
    expect(row.textContent).not.toContain(runDuration(4));
    const detail = parse(drawer());
    const priceRow = [...detail.querySelectorAll('.kv > div')].find(
      (row) => row.querySelector('dt')?.textContent === t('cost.price'),
    )!;
    expect(priceRow).toBeDefined();
    expect(priceRow.querySelector('dd')?.textContent).toContain(
      t('cost.perInstance', { price: money(0.69, 'USD') }),
    );
  });

  it('labels observation-only periods without claiming a lower bound and freezes stale estimates', () => {
    setLocale(language);
    const { item, source, drawer, cloud } = fixture();
    item.started_at = null;
    source.stale = true;
    expect(text(drawer())).toContain(t('cost.observedFor', { duration: runDuration(1) }));
    expect(text(drawer())).toContain(t('cost.estimate', { cost: money(0.69, 'USD') }));
    expect(text(drawer())).toContain(t('cost.asOf', { time: dateTime(source.last_success) }));
    expect(text(drawer())).not.toContain(
      t('cost.estimate', { cost: money(0.69, 'USD') }).replace('≈', '≥'),
    );
    const row = firstRow(cloud());
    expect(row.querySelector('td .sub')).toBeNull();
    expect(cell(row, t('usage.col.platform')).textContent).toBe(item.platform);
    const state = cell(row, t('jobs.col.state'));
    expect(state.querySelector('.status')?.textContent).toBe(statusLabel('running'));
    expect(row.textContent).not.toContain(`≈ ${money(0.69, 'USD')}`);
    // The frozen row is marked stale beside its state instead of with a tag on the name.
    expect(row.classList.contains('stale-row')).toBe(true);
    expect(state.querySelector('.stale-mark')?.getAttribute('title')).toBe(
      t('cloud.staleSince', { time: relativeTime(item.observed_at) }),
    );
    expect(row.textContent).not.toContain(t('cost.asOf', { time: dateTime(source.last_success) }));
  });

  it('lists missing cost coverage, keeps currencies separate and uses the selected server scope', () => {
    setLocale(language);
    const { data, item, source, ctx, cloud } = fixture();
    data.instances.push(
      { ...item, id: 'unpriced', name: 'Unpriced pod', hourly_cost: null },
      { ...item, id: 'euro', name: 'Euro pod', hourly_cost: 2, currency: 'EUR' },
    );
    ctx.data = serverDashboard(data);
    ctx.query = item.name;
    const html = cloud();
    // One tile per currency: the currency is in the label, the lower bound on the value.
    const usdRate = `≥ ${t('usage.hourlyRate', { price: money(0.69, 'USD', true) })}`;
    const usd = tile(html, `${t('cost.now')} · USD`)!;
    const eur = tile(html, `${t('cost.now')} · EUR`)!;
    expect(usd.textContent).toBe(usdRate);
    expect(eur.textContent).toBe(`≥ ${t('usage.hourlyRate', { price: money(2, 'EUR', true) })}`);
    // The rate itself counts the unpriced pod; its list names it (see quiet-markers.test).
    const trigger = usd.querySelector('button.partial')!;
    expect(trigger.getAttribute('aria-label')).toBe(
      `${usdRate}, ${t('cost.unpriced', { count: 1 })}`,
    );
    expect(trigger.getAttribute('title')).toBe(t('cost.unpriced', { count: 1 }));
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(text(html)).not.toContain(t('cost.unpriced', { count: 1 }));
    expect(text(html)).not.toContain('Unpriced pod');
    ctx.group = source.cluster_id;
    expect(tile(cloud(), `${t('cost.now')} · USD`)?.textContent).toBe(usdRate);
    ctx.group = 'missing-group';
    expect(text(cloud())).not.toContain(t('cost.now'));
  });

  it('shows unknown cost and conditional pricing for uncertain or stopped instances', () => {
    setLocale(language);
    const { item, ctx, drawer, cloud } = fixture();
    for (const state of ['desired_running', 'unknown', 'missing', 'stopped']) {
      item.state = state;
      expect(text(drawer())).toContain(t('cloud.priceWhenRunning', { price: money(0.69, 'USD') }));
      // Not running: no row in the Spend panel's instance costs table.
      expect(
        parse(renderToStaticMarkup(<UsagePage ctx={ctx} />)).querySelectorAll(
          `tr[data-detail-id="${item.id}"]`,
        ),
      ).toHaveLength(0);
      for (const html of [drawer(), cloud()]) {
        expect(text(html)).not.toContain(t('cost.estimate', { cost: money(2.76, 'USD') }));
        expect(text(html)).not.toContain(t('cost.runningFor', { duration: runDuration(4) }));
      }
      const row = firstRow(cloud());
      expect(row.querySelector('td .sub')).toBeNull();
      expect(cell(row, t('usage.col.platform')).textContent).toBe(item.platform);
      expect(cell(row, t('jobs.col.state')).textContent).toBe(statusLabel(state));
      expect(rowLabel(cloud()).textContent).not.toContain('—');
      // The price applies only while running: shown muted, not as unknown.
      const price = cell(row, t('cost.price'));
      expect(price.querySelector('.muted [aria-hidden="true"]')?.textContent).toBe(
        t('usage.hourlyRate', { price: money(0.69, 'USD') }),
      );
      // Screen readers and the tooltip get the qualifier the muted style shows.
      const whenRunning = t('cloud.priceWhenRunning', { price: money(0.69, 'USD') });
      expect(price.querySelector('.muted .sr-only')?.textContent).toBe(whenRunning);
      expect(price.querySelector('.muted')?.getAttribute('title')).toBe(whenRunning);
      expect(price.textContent).not.toContain('—');
      expect(text(drawer())).not.toContain(t('cost.excludes'));
    }
    item.state = 'running';
    item.hourly_cost = null;
    const element = document.createElement('div');
    element.innerHTML = drawer();
    const costRow = [...element.querySelectorAll('.kv > div')].find(
      (row) => row.querySelector('dt')?.textContent === t('cost.thisRun'),
    )!;
    expect(costRow.textContent).toContain('—');
    expect(costRow.textContent).not.toContain(money(0, 'USD'));
    expect(costRow.textContent).not.toContain(t('cost.excludes'));
    expect(rowLabel(cloud()).textContent).not.toContain('—');
    // An unknown price is "—" in the Price column, never a made-up zero.
    const price = cell(firstRow(cloud()), t('cost.price'));
    expect(price.textContent).toBe('—');
    expect(price.textContent).not.toContain(money(0, 'USD'));
  });

  it('formats elapsed time as minutes or days and hours', () => {
    setLocale(language);
    for (let minutes = 0; minutes < 60; minutes++) {
      expect(runDuration(minutes / 60)).toBe(
        language === 'en' ? `${minutes} min` : `${minutes} 分钟`,
      );
    }
    for (const [hours, en, zh] of [
      [1, '1 h', '1 小时'],
      [23.99, '23 h', '23 小时'],
      [24, '1 d', '1 天'],
      [48, '2 d', '2 天'],
      [76, '3 d 4 h', '3 天 4 小时'],
      [720.4, '30 d', '30 天'],
      [721.4, '30 d 1 h', '30 天 1 小时'],
    ] as const)
      expect(runDuration(hours)).toBe(language === 'en' ? en : zh);
  });

  it('distinguishes no priced instance running from unknown cost', () => {
    setLocale(language);
    const { item, data, ctx, cloud } = fixture();
    const spendPanel = () =>
      [...parse(renderToStaticMarkup(<UsagePage ctx={ctx} />)).querySelectorAll('.panel')].find(
        (panel) => panel.querySelector('h2')?.textContent === t('usage.spendNow'),
      )!;
    item.state = 'stopped';
    ctx.data = serverDashboard(data);
    // Nothing priced is running: Cloud claims no rate, and the Spend panel says so.
    expect(tile(cloud(), t('cost.now'))).toBeUndefined();
    expect(spendPanel().querySelector('.empty')?.textContent).toBe(t('cost.none'));
    item.state = 'running';
    item.hourly_cost = null;
    ctx.data = serverDashboard(data);
    // Running without a price: the rate is unknown, and the unknown value opens the list.
    const now = tile(cloud(), t('cost.now'))!;
    expect(now.textContent).toBe('—');
    expect(now.querySelector('button.partial')?.getAttribute('aria-label')).toBe(
      `—, ${t('cost.unpriced', { count: 1 })}`,
    );
    expect(text(cloud())).not.toContain(t('cost.none'));
    expect(spendPanel().querySelector('.empty')?.textContent).toBe(t('status.unknown'));
    expect(spendPanel().textContent).not.toContain(t('cost.none'));
  });

  it('hides spend for scopes with only SSH or unpriced hand-added machines', () => {
    setLocale(language);
    const { item, source, data, ctx, cloud } = fixture();
    source.driver = 'ssh';
    item.hourly_cost = null;
    ctx.data = serverDashboard(data);
    expect(text(cloud())).not.toContain(t('cost.now'));
    source.stale = true;
    ctx.data = serverDashboard(data);
    expect(text(cloud())).not.toContain(t('cost.now'));
    data.sources = [];
    item.manual = true;
    item.source_id = 'manual';
    ctx.data = serverDashboard(data);
    expect(text(cloud())).not.toContain(t('cost.now'));
    item.hourly_cost = 1;
    ctx.data = serverDashboard(data);
    expect(text(cloud())).toContain(t('cost.now'));
  });

  it('hides spend for disabled-only sources in both fleet and group views', () => {
    setLocale(language);
    const { source, data, ctx, cloud } = fixture();
    source.enabled = false;
    ctx.data = serverDashboard(data);
    expect(text(cloud())).not.toContain(t('cost.now'));
    ctx.group = source.cluster_id;
    expect(text(cloud())).not.toContain(t('cost.now'));
  });

  it('shows the new example provider states and keeps hand-added rows compact', () => {
    setLocale(language);
    const data = structuredClone(demo);
    const observedPod = data.instances.find((item) => item.name === 'batch-inference')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(observedPod.seen_running_since!) + 2 * 3600000));
    const ctx = {
      data,
      groups: groupsOf(data),
      group: 'all',
      query: '',
      demo: true,
      searchRef: { current: null },
    } as unknown as Ctx;
    const html = renderToStaticMarkup(<CloudPage ctx={ctx} />);
    const rows = [...parse(html).querySelectorAll('tbody tr')];
    const row = (name: string) =>
      rows.find((entry) => entry.querySelector('strong')?.textContent === name)!;
    const label = (name: string) => row(name).querySelector('td')!;
    // Rows are one line: the name cell holds only the name. Run time and estimates are in drawers.
    const observed = label('batch-inference');
    expect(observed.querySelector('.sub')).toBeNull();
    expect(row('batch-inference').textContent).not.toContain(`seen running ${runDuration(2)}`);
    expect(row('gpu-eval').textContent).not.toContain(`up ${runDuration(6)}`);
    for (const name of ['dev-box', 'build-box', 'ssh-shortcut']) {
      expect(label(name).querySelector('.sub')).toBeNull();
      expect(label(name).textContent).not.toContain('—');
    }
    // The running rate counts the two unpriced instances in its accessible name, not as text.
    const trigger = tile(html, `${t('cost.now')} · USD`)!.querySelector('button.partial')!;
    expect(trigger.getAttribute('title')).toBe(t('cost.unpriced', { count: 2 }));
    expect(trigger.getAttribute('aria-label')).toBe(
      `${trigger.textContent}, ${t('cost.unpriced', { count: 2 })}`,
    );
    expect(trigger.textContent).toMatch(/^≥ /);
    expect(text(html)).not.toContain(t('cost.unpriced', { count: 2 }));
  });
});

it.each(['en', 'zh-CN'] as const)(
  'rounds the Cloud running-rate lower bound down (%s)',
  (locale) => {
    setLocale(locale);
    const { data, item, cloud } = fixture();
    data.instances.push({ ...item, id: 'unpriced', hourly_cost: null });
    item.hourly_cost = 0.9567;
    data.summary = serverDashboard(data).summary;
    const now = tile(cloud(), t('cost.now'))!;
    const floored = t('usage.hourlyRate', { price: money(0.9567, 'USD', true) });
    expect(floored).not.toBe(t('usage.hourlyRate', { price: money(0.9567, 'USD') }));
    expect(now.textContent).toBe(`≥ ${floored}`);
    expect(now.querySelector('button.partial')?.getAttribute('aria-label')).toBe(
      `≥ ${floored}, ${t('cost.unpriced', { count: 1 })}`,
    );
  },
);

it.each(['en', 'zh-CN'] as const)(
  'explains a missing hand-added machine run start (%s)',
  (locale) => {
    setLocale(locale);
    const { item, drawer } = fixture();
    item.manual = true;
    item.started_at = null;
    item.seen_running_since = null;
    expect(drawer()).toContain(t('cost.manualStartUnknown'));
  },
);
