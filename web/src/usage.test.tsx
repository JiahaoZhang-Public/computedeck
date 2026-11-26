// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { money, calendarDate, clockTime } from './domain';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { UsageHistory, UsagePage } from './pages/Usage';
import type { Ctx } from './pages/shared';
import { RankedBars } from './ui';
import type { UsageRollups } from './types';
import { usageDays, usageTotal, mergeUnrecordedDays } from './usage';
import { serverDemo } from './test-server';
import { setRouteParams } from './useRouteParam';

vi.mock('./api', () => ({ api: vi.fn() }));
let demo: ReturnType<typeof serverDemo>;
beforeAll(() => {
  demo = serverDemo();
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  setLocale('en');
});
const end = Date.parse('2026-01-02T12:00:00Z');
const hour = 3600000;
function rollups(): UsageRollups {
  return {
    start: new Date(end - 2 * hour).toISOString(),
    end: new Date(end).toISOString(),
    buckets: [
      {
        at: new Date(end - 2 * hour).toISOString(),
        end: new Date(end - hour).toISOString(),
        observed_seconds: 0,
        groups: {},
      },
      {
        at: new Date(end - hour).toISOString(),
        end: new Date(end).toISOString(),
        observed_seconds: 1800,
        groups: {
          'example:cluster-a': {
            gpu_hours: 2,
            gpu_observed_seconds: 1800,
            spend: { USD: 1, EUR: 3 },
            observed_seconds: 1800,
            gpu_partial: true,
            spend_partial: true,
            spend_known: true,
          },
        },
      },
    ],
  };
}
function context(): Ctx {
  const data = structuredClone(demo);
  return {
    data,
    groups: groupsOf(data),
    demo: false,
    locale: 'en',
    openInstance: vi.fn(),
  } as unknown as Ctx;
}
function dom(html: string) {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}
/** The day table under its `h3` heading ("GPU-hours" or "Estimated spend"). */
function dayTable(html: Element, heading: string) {
  const title = [...html.querySelectorAll('h3')].find((h3) => h3.textContent === heading);
  return title?.nextElementSibling?.querySelector('table') ?? null;
}
/** The cell of `row` under the column headed `header`: one value per cell. */
function cellOf(row: Element, header: string) {
  const headers = [...row.closest('table')!.querySelectorAll('thead th')].map(
    (th) => th.textContent,
  );
  expect(headers).toContain(header);
  return row.children[headers.indexOf(header)] as HTMLElement;
}
/** A day table's column: one cell per day row, and the tfoot total. */
function column(table: Element | null, header: string) {
  expect(table).not.toBeNull();
  return {
    cells: [...table!.querySelectorAll('tbody tr')].map((row) => cellOf(row, header)),
    total: cellOf(table!.querySelector('tfoot tr')!, header),
  };
}
/** A stat tile's value; its label carries the meaning (and the currency when several). */
function tile(html: Element, label: string) {
  return [...html.querySelectorAll('.stat')]
    .find((stat) => stat.querySelector('.stat-label')?.textContent === label)
    ?.querySelector('.stat-value');
}
function panel(html: Element, title: string) {
  return [...html.querySelectorAll('.panel')].find(
    (panel) => panel.querySelector('h2')?.textContent === title,
  );
}

it('clips hourly buckets, sums currencies separately, and keeps unobserved hours unknown', () => {
  const result = usageTotal(rollups(), end - 2 * hour, end);
  expect(result).toEqual({
    gpuHours: 2,
    spend: { USD: 1, EUR: 3 },
    observed: 1800,
    gpuObserved: 1800,
    gpuPartial: true,
    spendPartial: true,
    spendKnown: true,
  });
  expect(usageTotal(rollups(), end - 2 * hour, end - hour).gpuHours).toBeNull();
  expect(usageTotal(rollups(), end - hour / 2, end).spend).toEqual({ USD: 0.5, EUR: 1.5 });
  expect(usageTotal(rollups(), end - hour, end, 'missing').observed).toBe(0);
});

it('does not turn an unknown cloud cost into known zero from an unrelated cluster', () => {
  const data = rollups();
  const group = data.buckets[1].groups['example:cluster-a'];
  group.spend = {};
  group.spend_known = false;
  data.buckets[1].groups['other'] = { ...group, spend_known: true, spend_partial: false };
  expect(usageTotal(data, end - hour, end).spendKnown).toBe(false);
});

it('uses local calendar boundaries rather than UTC labels or fixed 24-hour steps', () => {
  const left = new Date(2026, 2, 7, 18).getTime(),
    right = new Date(2026, 2, 10, 6).getTime();
  const days = usageDays(left, right);
  expect(days.map((day) => day.label.getDate())).toEqual([7, 8, 9, 10]);
  expect(days[0].start).toBe(left);
  expect(days.at(-1)?.end).toBe(right);
  expect(days[1].label.getHours()).toBe(0);
  expect(days.reduce((sum, day) => sum + day.end - day.start, 0)).toBe(right - left);
});

describe.each(['en', 'zh-CN'] as const)('usage and cost in %s', (locale) => {
  it('labels both cut-off days in a mid-day 24-hour range for GPU-hours and spend', () => {
    setLocale(locale);
    const ctx = context();
    ctx.locale = locale;
    const start = new Date(2026, 0, 2, 14, 11).getTime();
    const data = rollups();
    data.start = new Date(start).toISOString();
    data.end = new Date(start + 24 * hour).toISOString();
    const group = data.buckets[1].groups['example:cluster-a'];
    data.buckets = Array.from({ length: 24 }, (_, index) => ({
      at: new Date(start + index * hour).toISOString(),
      end: new Date(start + (index + 1) * hour).toISOString(),
      observed_seconds: 3600,
      groups: {
        'example:cluster-a': {
          ...group,
          observed_seconds: 3600,
          gpu_observed_seconds: 3600,
        },
      },
    }));
    const html = dom(renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={ctx} />));
    const time = clockTime(start);
    const labels = usageDays(start, start + 24 * hour).map(
      (day, index) =>
        `${calendarDate(day.label)} · ${t(index ? 'usage.dayUntil' : 'usage.dayFrom', { time })}`,
    );
    for (const heading of [t('usage.gpuHours'), t('usage.estimatedSpend')]) {
      const table = dayTable(html, heading);
      expect(table).not.toBeNull();
      expect(
        [...table!.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')?.textContent),
      ).toEqual(labels);
      // A fully observed day carries no caption; only gaps are called out.
      expect(table!.querySelectorAll('[title]')).toHaveLength(0);
    }
  });

  it('uses a usage-specific empty state for current GPU groups', () => {
    setLocale(locale);
    const ctx = context();
    ctx.groups = [];
    const html = dom(renderToStaticMarkup(<UsagePage ctx={ctx} />));
    expect(html.textContent).toContain(t('usage.noGroups'));
    expect(html.textContent).not.toContain(t('cloud.empty'));
  });

  it('prints currency once, translates hourly bars, hides unrelated currencies and omits missing run information', () => {
    setLocale(locale);
    const ctx = context();
    const html = dom(renderToStaticMarkup(<UsagePage ctx={ctx} />));
    const spend = panel(html, t('usage.spendNow'))!;
    // One bar list per currency, in the order of the current rates.
    const currencies = Object.keys(ctx.data.summary.spend!.rates);
    expect([...currencies].sort()).toEqual(['EUR', 'USD']);
    const lists = [...spend.querySelectorAll('.ranked-bars')];
    expect(lists).toHaveLength(currencies.length);
    const bars = (currency: string) => lists[currencies.indexOf(currency)];
    const values = (currency: string) =>
      [...bars(currency).querySelectorAll('.ranked-value')].map((row) => row.textContent);
    for (const currency of ['USD', 'EUR']) {
      // The currency is printed once, in the tile label; values carry only the symbol.
      for (const label of [t('cost.now'), t('usage.perDay')]) {
        const value = tile(html, `${label} · ${currency}`);
        expect(value).toBeTruthy();
        expect(value!.textContent).not.toContain(currency);
      }
      expect(values(currency)).toContain(
        `${currency === 'USD' ? '≥ ' : ''}${t('usage.hourlyRate', { price: money(currency === 'USD' ? 1.04 : 0.4, currency) })}`,
      );
      for (const value of values(currency)) expect(value).not.toContain(currency);
    }
    expect(bars('USD').textContent).not.toContain('Lab workstation');
    expect(bars('USD').textContent).not.toContain('Example EC2');
    expect(html.textContent).toContain('Example EC2');
    expect(values('USD')).not.toContain('—');
    expect(bars('EUR').textContent).not.toMatch(/RunPod|Example EC2/);
    // A hand-added machine has no tracked run: run time and cost so far stay unknown.
    const manual = [...spend.querySelectorAll('tbody tr')].find(
      (row) => row.querySelector('strong')?.textContent === 'dev-box',
    )!;
    expect(cellOf(manual, t('usage.col.rate')).textContent).toBe(
      t('usage.hourlyRate', { price: money(0.4, 'EUR') }),
    );
    expect(cellOf(manual, t('usage.col.runningFor')).textContent).toBe('—');
    expect(cellOf(manual, t('usage.col.costSoFar')).textContent).toBe('—');
    const daily = dom(
      renderToStaticMarkup(<UsageHistory rollups={rollups()} hours={24} ctx={ctx} />),
    );
    const labels = [...daily.querySelectorAll('.stat-label')];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.textContent?.match(/USD|EUR/g)).toHaveLength(1);
    // Daily spend keeps one column per currency; the cells hold only the amount.
    const table = dayTable(daily, t('usage.estimatedSpend'))!;
    expect([...table.querySelectorAll('thead th')].slice(1).map((th) => th.textContent)).toEqual([
      'EUR',
      'USD',
    ]);
    for (const td of table.querySelectorAll('td')) expect(td.textContent).not.toMatch(/USD|EUR/);
  });

  it('scales fractional values to the largest row and leaves zero or unknown tracks empty', () => {
    const widths = (values: (number | null)[]) =>
      [
        ...dom(
          renderToStaticMarkup(
            <RankedBars
              items={values.map((value, index) => ({
                key: String(index),
                label: String(index),
                value,
              }))}
            />,
          ),
        ).querySelectorAll<HTMLElement>('.ranked-track i'),
      ].map((bar) => bar.style.width);
    expect(widths([0.4, 0.2])).toEqual(['100%', '50%']);
    expect(widths([0, null])).toEqual(['0%', '0%']);
  });

  it('treats microsecond timestamp truncation as full coverage', () => {
    setLocale(locale);
    const data = rollups();
    data.end = '2026-01-02T12:00:00.123456Z';
    data.buckets = [
      {
        at: '2026-01-02T11:00:00.123800Z',
        end: data.end,
        observed_seconds: 3599.999656,
        groups: {
          'example:cluster-a': {
            ...data.buckets[1].groups['example:cluster-a'],
            observed_seconds: 3599.999656,
            gpu_observed_seconds: 3599.999656,
          },
        },
      },
    ];
    const html = dom(
      renderToStaticMarkup(<UsageHistory rollups={data} hours={1} ctx={context()} />),
    );
    // Truncated timestamps count as full coverage, so no day cell claims a gap.
    const tables = [t('usage.gpuHours'), t('usage.estimatedSpend')].map((heading) =>
      dayTable(html, heading),
    );
    for (const table of tables) {
      expect(table?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
      expect(table!.querySelectorAll('[title]')).toHaveLength(0);
    }
    expect(html.innerHTML).not.toContain(t('usage.coverage', { percent: 99 }));
  });

  it('formats GPU-hours concisely and leaves unknown units out', () => {
    setLocale(locale);
    const ctx = context();
    ctx.locale = locale;
    for (const [value, text] of [
      [2.34, '2.3'],
      [2.39, '2.3'],
      [2.3 - 1e-14, '2.3'],
      [166 - 1e-12, '166'],
      [499.5, '499'],
      [166.5, '166'],
      [2400.09, (2400).toLocaleString(locale)],
      [null, '—'],
    ] as const) {
      const data = rollups();
      data.buckets[1].groups['example:cluster-a'].gpu_hours = value;
      const html = dom(renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={ctx} />));
      // The unit is the table heading; the Cluster A total holds only the number.
      const { total } = column(dayTable(html, t('usage.gpuHours')), 'Cluster A');
      expect(total.textContent).toBe(value == null ? '—' : `≥ ${text}`);
      expect(total.textContent).not.toContain('GPU-hours');
    }
  });

  it('shows not measured for a failed group throughout a day and counts only known GPU time', () => {
    setLocale(locale);
    const data = rollups();
    const start = new Date(2026, 0, 2).getTime();
    data.start = new Date(start).toISOString();
    data.end = new Date(start + 24 * hour).toISOString();
    const group = data.buckets[1].groups['example:cluster-a'];
    data.buckets = Array.from({ length: 24 }, (_, index) => ({
      at: new Date(start + index * hour).toISOString(),
      end: new Date(start + (index + 1) * hour).toISOString(),
      observed_seconds: 3600,
      groups: {
        'example:cluster-a': {
          ...group,
          gpu_hours: null,
          gpu_observed_seconds: 0,
          observed_seconds: 3600,
        },
      },
    }));
    let html = dom(
      renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={context()} />),
    );
    let gpu = column(dayTable(html, t('usage.gpuHours')), 'Cluster A');
    expect(gpu.cells).toHaveLength(1);
    // Observed but never measured: unknown, and the cell's title says why.
    expect(gpu.cells[0].textContent).toBe('—');
    expect(gpu.cells[0].getAttribute('title')).toBe(t('usage.notMeasured'));
    expect(gpu.total.textContent).toBe('—');
    Object.assign(data.buckets[0].groups['example:cluster-a'], {
      gpu_hours: 2,
      gpu_observed_seconds: 3600,
    });
    html = dom(renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={context()} />));
    gpu = column(dayTable(html, t('usage.gpuHours')), 'Cluster A');
    // Only the measured hour counts: a lower bound whose title discloses the coverage gap.
    expect(gpu.cells[0].textContent).toBe('≥ 2');
    expect(gpu.cells[0].getAttribute('title')).toBe(t('usage.coverage', { percent: 4 }));
    expect(gpu.total.textContent).toBe('≥ 2');
  });

  it.each([4.35, 0.29, 66.6 - 1e-12])(
    'preserves exact cents in partial USD totals and bars: %s',
    (value) => {
      setLocale(locale);
      const data = rollups();
      data.buckets[1].groups['example:cluster-a'].spend = { USD: value };
      const html = dom(
        renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={context()} />),
      );
      const expected = `≥ ${money(value, 'USD')}`;
      // The USD column total and its day cell keep exact cents; so does the seven-day tile.
      const usd = column(dayTable(html, t('usage.estimatedSpend')), 'USD');
      expect(usd.total.textContent).toBe(expected);
      expect(usd.cells.some((cell) => cell.textContent === expected)).toBe(true);
      expect(tile(html, t('usage.sevenDays'))?.textContent).toBe(expected);
      expect(money(value, 'USD', true)).toBe(money(value, 'USD'));
      expect(money(value, 'invalid', true)).toBe(`invalid ${value.toFixed(2)}`);
      expect(money(1.239, 'invalid', true)).toBe('invalid 1.23');
    },
  );

  it('floors partial spend and gives removed platforms a readable name', () => {
    setLocale(locale);
    const data = rollups();
    const group = data.buckets[1].groups['example:cluster-a'];
    group.spend = { USD: 1.239 };
    data.buckets[1].groups = { 'platform:lab workstation': group };
    const ctx = context();
    ctx.groups = ctx.groups.filter((group) => group.key !== 'platform:lab workstation');
    const html = dom(renderToStaticMarkup(<UsageHistory rollups={data} hours={24} ctx={ctx} />));
    const gpu = dayTable(html, t('usage.gpuHours'))!;
    expect([...gpu.querySelectorAll('thead th')].map((th) => th.textContent)).toContain(
      t('usage.removedGroup', { name: 'lab workstation' }),
    );
    expect(html.textContent).not.toContain('platform:');
    const usd = column(dayTable(html, t('usage.estimatedSpend')), 'USD');
    expect(usd.total.textContent).toBe(`≥ ${money(1.23, 'USD')}`);
    expect(usd.cells.some((cell) => cell.textContent === `≥ ${money(1.23, 'USD')}`)).toBe(true);
    expect(money(1.239, 'USD')).toBe(money(1.24, 'USD'));
  });

  it.each(['', '2026-01-14T14:00:00Z'])(
    'requests only current week rollups beside the selected chart (end=%s)',
    async (at) => {
      setLocale(locale);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const suffix = at ? `&end=${encodeURIComponent(at)}` : '';
      window.history.replaceState(null, '', `/#/usage?range=24h${suffix}`);
      vi.mocked(api).mockResolvedValue({ points: [], rollups: rollups() });
      const host = document.createElement('div'),
        root = createRoot(host);
      try {
        await act(async () => root.render(<UsagePage ctx={context()} />));
        expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
          `/history?hours=24&rollup=1&chart=1&demo=false${suffix}`,
          '/history?hours=168&rollup=1&demo=false',
        ]);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it.each([
    ['7d', 168],
    ['30d', 720],
  ] as const)(
    'reuses %s rollups for week totals and keeps the chart at heading level three',
    async (range, hours) => {
      setLocale(locale);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      window.history.replaceState(null, '', `/#/usage?range=${range}`);
      vi.mocked(api).mockResolvedValue({ points: [], rollups: rollups() });
      const host = document.createElement('div'),
        root = createRoot(host);
      const ctx = context();
      try {
        await act(async () => root.render(<UsagePage ctx={ctx} />));
        expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
          `/history?hours=${hours}&rollup=1&chart=1&demo=false`,
        ]);
        expect(host.querySelector('.panel .panel')).toBeNull();
        expect(host.querySelector('.usage-trend h3')?.textContent).toBe(t('chart.heading'));
        ctx.data.history = [{ ...ctx.data.history.at(-1)!, at: new Date(end).toISOString() }];
        await act(async () => root.render(<UsagePage ctx={ctx} />));
        expect(api).toHaveBeenCalledTimes(2);
        expect(vi.mocked(api).mock.calls.every(([path]) => path.includes(`hours=${hours}&`))).toBe(
          true,
        );
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it('anchors the seven-day total and coverage to the week response end', () => {
    setLocale(locale);
    const week = rollups(),
      selected = rollups();
    selected.end = new Date(end - hour / 2).toISOString();
    const html = dom(
      renderToStaticMarkup(
        <UsageHistory rollups={selected} week={week} hours={24} ctx={context()} />,
      ),
    );
    // One seven-day tile per currency; the partial figure itself opens its coverage gap.
    const coverage = t('usage.coverage', { percent: 0 });
    for (const [currency, amount] of [
      ['USD', 1],
      ['EUR', 3],
    ] as const) {
      const value = tile(html, `${t('usage.sevenDays')} · ${currency}`)!;
      expect(value.textContent).toBe(`≥ ${money(amount, currency)}`);
      const trigger = value.querySelector('button.partial')!;
      expect(trigger.getAttribute('title')).toBe(coverage);
      expect(trigger.getAttribute('aria-label')).toBe(`≥ ${money(amount, currency)}, ${coverage}`);
      expect(value.querySelector('[role="img"]')).toBeNull();
    }
  });

  it.each([
    ['24', 24, 'chart.range.day'],
    ['72', 168, 'chart.range.week'],
    ['3d', 168, 'chart.range.week'],
    ['168', 168, 'chart.range.week'],
  ] as const)('maps legacy range %s to an offered chip', async (range, hours, label) => {
    setLocale(locale);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', `/#/usage?range=${range}`);
    vi.mocked(api).mockResolvedValue({ points: [], rollups: rollups() });
    const host = document.createElement('div'),
      root = createRoot(host);
    try {
      await act(async () => root.render(<UsagePage ctx={context()} />));
      expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
      expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(t(label));
      expect(
        vi.mocked(api).mock.calls.some(([path]) => path.includes(`hours=${hours}&rollup=1`)),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('ranks top eight plus a partial Other and hatches unknown values', () => {
    setLocale(locale);
    const html = dom(
      renderToStaticMarkup(
        <RankedBars
          items={Array.from({ length: 10 }, (_, i) => ({
            key: String(i),
            label: `Group ${i}`,
            value: i === 0 ? null : i,
          }))}
        />,
      ),
    );
    const rows = [...html.querySelectorAll('li')];
    expect(rows).toHaveLength(9);
    expect(rows[0].textContent).toContain('Group 9');
    expect(rows[8].querySelector('.with-mark > span:last-child')?.textContent).toBe(
      t('usage.other'),
    );
    expect(rows[8].querySelector('.ranked-value')?.textContent).toBe('≥ 1');
    expect(rows[8].querySelector('.ranked-track.partial')).not.toBeNull();
    const unknown = dom(
      renderToStaticMarkup(<RankedBars items={[{ key: 'x', label: 'X', value: null }]} />),
    );
    expect(unknown.querySelector('.ranked-value')?.textContent).toBe('—');
    expect(unknown.querySelector('i')?.style.width).toBe('0%');
  });

  it('reads current figures from the summary, excludes disabled and uncertain instances, and labels projections', () => {
    setLocale(locale);
    const ctx = context();
    ctx.data.summary.groups['example:cluster-a'].allocated = 123;
    const pod = ctx.data.instances.find((item) => item.name === 'sd-inference')!;
    const source = ctx.data.sources.find((item) => item.id === pod.source_id)!;
    let html = dom(renderToStaticMarkup(<UsagePage ctx={ctx} />));
    expect(html.textContent).toContain('123');
    expect(html.textContent).toContain(t('usage.spendNow'));
    // Unpriced instances keep every current rate a lower bound, currency by currency.
    expect(tile(html, `${t('cost.now')} · EUR`)?.textContent).toBe(
      `≥ ${t('usage.hourlyRate', { price: money(0.4, 'EUR', true) })}`,
    );
    expect(Object.keys(ctx.data.summary.groups).sort()).toEqual(
      ctx.groups.map((group) => group.key).sort(),
    );
    // The only table is the priced instances' costs: one row each, the drawer has the rest.
    expect(html.querySelectorAll('table')).toHaveLength(1);
    expect([...html.querySelectorAll('table thead th')].map((th) => th.textContent)).toEqual([
      t('cloud.col.instance'),
      t('usage.col.rate'),
      t('usage.col.runningFor'),
      t('usage.col.costSoFar'),
    ]);
    expect(html.textContent).not.toContain(locale === 'en' ? 'Instance prices' : '实例单价');
    const costRow = () => html.querySelector(`tbody tr[data-detail-id="${pod.id}"]`);
    expect(costRow()?.querySelector('strong')?.textContent).toBe(pod.name);
    // The projection is labelled by its tile, and stays a lower bound.
    expect(tile(html, `${t('usage.perDay')} · USD`)?.textContent).toBe(`≥ ${money(24.96, 'USD')}`);
    source.enabled = false;
    html = dom(renderToStaticMarkup(<UsagePage ctx={ctx} />));
    expect(html.querySelectorAll('table tbody tr').length).toBeGreaterThan(0);
    expect(costRow()).toBeNull();
    source.enabled = true;
    pod.state = 'unknown';
    html = dom(renderToStaticMarkup(<UsagePage ctx={ctx} />));
    expect(html.querySelectorAll('table tbody tr').length).toBeGreaterThan(0);
    expect(costRow()).toBeNull();
  });

  it('renders daily lower bounds, coverage, unknowns, currencies and pre-upgrade days', () => {
    setLocale(locale);
    const ctx = context();
    ctx.locale = locale;
    const html = dom(
      renderToStaticMarkup(<UsageHistory rollups={rollups()} hours={168} ctx={ctx} />),
    );
    const gpu = dayTable(html, t('usage.gpuHours'))!;
    const spend = dayTable(html, t('usage.estimatedSpend'))!;
    // Days before recording began: unknown dashes whose title says "not recorded".
    for (const table of [gpu, spend]) {
      const first = [...table.querySelectorAll('tbody tr')][0];
      const cells = [...first.querySelectorAll('td')].slice(1);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell.textContent).toBe('—');
        expect(cell.getAttribute('title')).toBe(t('usage.notRecorded'));
      }
    }
    // Currencies stay in separate columns, each a lower bound.
    expect(column(spend, 'USD').total.textContent).toBe(`≥ ${money(1, 'USD')}`);
    expect(column(spend, 'EUR').total.textContent).toBe(`≥ ${money(3, 'EUR')}`);
    expect(column(gpu, 'Cluster A').total.textContent).toBe('≥ 2');
    expect(column(gpu, 'Cluster A').cells.at(-1)?.textContent).toBe('≥ 2');
    const lastDay = usageDays(end - 168 * hour, end).at(-1)!;
    const coverage = t('usage.coverage', {
      percent: Math.floor((1800 / ((lastDay.end - lastDay.start) / 1000)) * 100),
    }); // 30 min of this 12-hour day.
    expect(column(gpu, 'Cluster A').cells.at(-1)?.getAttribute('title')).toBe(coverage);
    expect(column(spend, 'USD').cells.at(-1)?.getAttribute('title')).toBe(coverage);
    expect(column(spend, 'EUR').cells.at(-1)?.getAttribute('title')).toBe(coverage);
  });

  it('keeps range in the URL, ignores late responses, retries errors and opens instance buttons', async () => {
    setLocale(locale);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.history.replaceState(null, '', '/?demo=true#/usage?range=7d');
    const ctx = context();
    let resolveOld!: (value: unknown) => void;
    const old = new Promise((resolve) => {
      resolveOld = resolve;
    });
    vi.mocked(api).mockImplementation((path) =>
      path.includes('hours=168') ? old : Promise.reject(new Error('offline')),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<UsagePage ctx={ctx} />));
      expect(host.textContent).toContain(t('chart.loading'));
      // Each priced instance row opens its drawer.
      await act(async () =>
        host.querySelector<HTMLElement>('tbody tr[data-detail-key="instance"]')!.click(),
      );
      expect(ctx.openInstance).toHaveBeenCalledOnce();
      await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2].click());
      expect(window.location.hash).toContain('range=30d');
      await act(async () => resolveOld({ points: [], rollups: rollups() }));
      expect(host.textContent).toContain(t('chart.failed'));
      expect(host.querySelector('.usage-history')).toBeNull();
      vi.mocked(api).mockResolvedValue({ points: [], rollups: rollups() });
      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === t('usage.retry'))!
          .click(),
      );
      expect(host.querySelector('.usage-history')).not.toBeNull();
      await act(async () => setRouteParams({ range: '24h' }));
      expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe(t('chart.range.day'));
      expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('hours=24&rollup=1'))).toBe(
        true,
      );
      expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('hours=168&rollup=1'))).toBe(
        true,
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

it('collapses consecutive unrecorded days without merging measured or partly measured days', () => {
  const data = rollups();
  const days = usageDays(end - 30 * 24 * hour, end);
  for (const key of [undefined, 'example:cluster-a']) {
    const merged = mergeUnrecordedDays(days, data, key);
    expect(merged).toHaveLength(2);
    expect(merged[0].start).toBe(days[0].start);
    expect(merged[0].end).toBe(days.at(-1)!.start);
    expect(merged[1]).toEqual(days.at(-1));
    expect(usageTotal(data, merged[1].start, merged[1].end, key).observed).toBe(1800);
  }
  const ctx = context();
  const html = document.createElement('div');
  html.innerHTML = renderToStaticMarkup(<UsageHistory rollups={data} hours={720} ctx={ctx} />);
  // Both day tables show the merged unrecorded span and the measured day: two rows each.
  for (const heading of [t('usage.gpuHours'), t('usage.estimatedSpend')])
    expect(dayTable(html, heading)?.querySelectorAll('tbody tr')).toHaveLength(2);
});
