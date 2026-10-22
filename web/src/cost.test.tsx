// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dateTime, money, runDuration } from './domain';
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
    const label = rowLabel(cloud());
    expect(label.querySelectorAll('.sub')).toHaveLength(1);
    expect(label.querySelector('.sub')?.textContent).toBe(
      [
        item.platform,
        statusLabel(item.state),
        t('cost.up', { duration: runDuration(4) }),
        t('cost.shortEstimate', { cost: money(2.76, 'USD') }),
      ].join(' · '),
    );
    expect(label.textContent).not.toContain(`${money(0.69, 'USD')}/h`);
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
    const label = rowLabel(cloud());
    expect(label.querySelector('.sub')?.textContent).toBe(
      [
        item.platform,
        statusLabel(item.state),
        t('cost.seenRunning', { duration: runDuration(1) }),
        t('cost.shortEstimate', { cost: money(0.69, 'USD') }),
      ].join(' · '),
    );
    expect(label.querySelector('.tag')).not.toBeNull();
    expect(label.textContent).not.toContain(
      t('cost.asOf', { time: dateTime(source.last_success) }),
    );
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
    const html = text(cloud());
    expect(html).toContain(`≥ ${t('cost.rate', { price: money(0.69, 'USD'), currency: 'USD' })}`);
    expect(html).toContain(`≥ ${t('cost.rate', { price: money(2, 'EUR'), currency: 'EUR' })}`);
    expect(html).toContain('Unpriced pod');
    expect(html).toContain(t('cost.unpriced', { count: 1 }));
    ctx.group = source.cluster_id;
    expect(text(cloud())).toContain(
      `≥ ${t('cost.rate', { price: money(0.69, 'USD'), currency: 'USD' })}`,
    );
    ctx.group = 'missing-group';
    expect(text(cloud())).not.toContain(t('cost.now'));
  });

  it('shows unknown cost and conditional pricing for uncertain or stopped instances', () => {
    setLocale(language);
    const { item, ctx, drawer, cloud } = fixture();
    for (const state of ['desired_running', 'unknown', 'missing', 'stopped']) {
      item.state = state;
      expect(text(drawer())).toContain(t('cloud.priceWhenRunning', { price: money(0.69, 'USD') }));
      expect(text(renderToStaticMarkup(<UsagePage ctx={ctx} />))).toContain(
        t('cloud.priceWhenRunning', { price: money(0.69, 'USD') }),
      );
      for (const html of [drawer(), cloud()]) {
        expect(text(html)).not.toContain(t('cost.estimate', { cost: money(2.76, 'USD') }));
        expect(text(html)).not.toContain(t('cost.runningFor', { duration: runDuration(4) }));
      }
      const label = rowLabel(cloud());
      expect(label.querySelectorAll('.sub')).toHaveLength(1);
      expect(label.querySelector('.sub')?.textContent).toBe(
        `${item.platform} · ${statusLabel(state)}`,
      );
      expect(label.textContent).not.toContain('—');
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
    item.state = 'stopped';
    ctx.data = serverDashboard(data);
    expect(text(cloud())).toContain(t('cost.none'));
    expect(parse(cloud()).querySelector('.panel-note')?.textContent).not.toContain('—');
    item.state = 'running';
    item.hourly_cost = null;
    ctx.data = serverDashboard(data);
    expect(text(cloud())).not.toContain(t('cost.none'));
    expect(parse(cloud()).querySelector('.panel-note')?.textContent).toContain('—');
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
    const label = (name: string) =>
      rows.find((row) => row.querySelector('strong')?.textContent === name)!.querySelector('td')!;
    const observed = label('batch-inference');
    expect(observed.textContent).toContain(t('cost.seenRunning', { duration: runDuration(2) }));
    expect(observed.textContent).toContain(t('cost.shortEstimate', { cost: money(0.7, 'USD') }));
    expect(label('gpu-eval').textContent).toContain(t('cost.up', { duration: runDuration(6) }));
    for (const name of ['dev-box', 'build-box', 'ssh-shortcut']) {
      expect(label(name).querySelectorAll('.sub')).toHaveLength(1);
      expect(label(name).textContent).not.toContain('—');
    }
    expect(text(html)).toContain(t('cost.unpriced', { count: 2 }));
  });
});
