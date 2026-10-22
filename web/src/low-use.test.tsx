// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { lowUseText } from './domain';
import { formatMessage, lowUseDuration, setLocale, t } from './i18n';
import { groupsOf } from './groups';
import { CloudPage } from './pages/Cloud';
import { InstanceDetail } from './pages/Details';
import { PlanPage } from './pages/Plan';
import { SettingsPage } from './pages/Settings';
import type { Ctx } from './pages/shared';
import { serverDemo } from './test-server';
import { setRouteParams } from './useRouteParam';

vi.mock('./api', () => ({ api: vi.fn() }));
let demo: ReturnType<typeof serverDemo>;
beforeAll(() => {
  demo = serverDemo();
});
let root: Root;
let host: HTMLDivElement;
let ctx: Ctx;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/#/cloud');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const data = structuredClone(demo);
  ctx = {
    data,
    groups: groupsOf(data),
    group: 'all',
    query: '',
    searchRef: { current: null },
    setGroup: vi.fn(),
    setQuery: vi.fn(),
    openInstance: vi.fn(),
    demo: false,
    webPlugins: [],
    reload: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
  } as unknown as Ctx;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setLocale('en');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const workstation = () => ctx.data.instances.find((i) => i.name === 'dev-box')!;
function drawer(item = workstation()) {
  const element = document.createElement('div');
  element.innerHTML = renderToStaticMarkup(
    <InstanceDetail item={item} ctx={ctx} onProbe={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />,
  );
  return element;
}

describe.each(['en', 'zh-CN'] as const)('sustained low use in %s', (language) => {
  beforeEach(() => setLocale(language));
  it('shows the server readings without repeating the drawer name, with optional cost', () => {
    const item = workstation();
    const hint = ctx.data.attention!.find((a) => a.kind === 'instance_low_use')!;
    const sentence = lowUseText(item);
    expect(drawer().textContent).toContain(sentence);
    expect(sentence).not.toContain(item.name);
    expect(formatMessage(hint.message)).toBe(
      `${item.name}${language === 'en' ? ': ' : '：'}${sentence}`,
    );
    expect(drawer().textContent).toContain(lowUseDuration(60));
    expect(drawer().textContent).toContain(
      language === 'en' ? 'estimate, not a bill' : '估算值，非账单',
    );
    item.hourly_cost = null;
    expect(lowUseText(item)).not.toContain('≈');
    item.low_use!.origin = 'provider';
    expect(lowUseText(item)).toContain(t('lowUse.provider'));
  });
  it.each([
    [60, '1 h', '1 小时'],
    [45, '45 m', '45 分钟'],
    [150, '2 h 30 m', '2 小时 30 分钟'],
  ] as const)(
    'formats %i minutes consistently across all low-use displays',
    async (minutes, en, zh) => {
      const duration = language === 'en' ? en : zh;
      expect(lowUseDuration(minutes)).toBe(duration);
      workstation().low_use!.covered_minutes = minutes;
      await act(async () => root.render(<CloudPage ctx={ctx} />));
      expect(host.textContent).toContain(t('lowUse.short', { duration }));
      expect(lowUseText(workstation())).toContain(duration);
      const hint = ctx.data.attention!.find((a) => a.kind === 'instance_low_use')!;
      expect(formatMessage({ ...hint.message, minutes })).toContain(duration);
    },
  );
  it('filters Cloud through the URL and updates when a new server result clears the hint', async () => {
    await act(async () => root.render(<CloudPage ctx={ctx} />));
    expect(host.textContent).toContain(t('lowUse.short', { duration: lowUseDuration(60) }));
    const tabs = host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="' + t('lowUse.title') + '"] button',
    );
    await act(async () => tabs[1].click());
    expect(window.location.hash).toContain('use=low');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.querySelector('tbody')!.textContent).toContain('dev-box');
    workstation().low_use!.state = 'unknown';
    workstation().low_use!.reason = 'stale';
    await act(async () => root.render(<CloudPage ctx={{ ...ctx }} />));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(0);
    await act(async () => setRouteParams({ use: 'unknown' }));
    expect(host.querySelector('tbody')!.textContent).toContain('dev-box');
    expect(host.textContent).not.toContain(t('lowUse.short', { duration: lowUseDuration(60) }));
    expect(drawer().textContent).toContain(t('lowUse.stale'));
  });
  it('keeps the filters in the selected group and search scope', async () => {
    ctx.query = 'sd-inference';
    await act(async () => root.render(<CloudPage ctx={ctx} />));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    await act(async () => setRouteParams({ use: 'low' }));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(0);
    ctx.query = '';
    ctx.group = ctx.data.sources.find((s) => s.driver === 'runpod')!.cluster_id;
    await act(async () => root.render(<CloudPage ctx={{ ...ctx }} />));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(0);
  });
  it('points from Plan to the filtered paid low-use list, without a second idle panel', async () => {
    window.history.replaceState(null, '', '#/plan');
    await act(async () => root.render(<PlanPage ctx={ctx} />));
    expect(host.querySelector('a[href="#/cloud?use=low"]')!.textContent).toBe(
      t('lowUse.pointer', { count: 1 }),
    );
    workstation().low_use!.state = 'busy';
    await act(async () => root.render(<PlanPage ctx={{ ...ctx }} />));
    expect(host.querySelector('a[href="#/cloud?use=low"]')).toBeNull();
  });
  it('explains provider coverage and links only to HTTPS consoles', () => {
    const item = ctx.data.instances.find((i) => i.name === 'sd-inference')!;
    expect(drawer(item).textContent).toContain(t('lowUse.providerMissing'));
    expect(drawer(item).querySelector('a[target="_blank"]')!.getAttribute('href')).toBe(
      'https://console.runpod.io',
    );
    item.gpu_count = 0;
    expect(drawer(item).textContent).not.toContain(t('lowUse.title'));
    expect(drawer(item).querySelector('a[target="_blank"]')!.getAttribute('href')).toBe(
      'https://console.runpod.io',
    );
    item.console_url = 'javascript:alert(1)';
    expect(drawer(item).querySelector('a[target="_blank"]')).toBeNull();
    item.gpu_count = 2;
    item.low_use = { ...workstation().low_use!, state: 'unknown', reason: 'coverage', samples: 1 };
    expect(drawer(item).textContent).toContain(t('lowUse.coverage', { minutes: 60 }));
    ctx.data.sources.find((source) => source.id === item.source_id)!.driver = 'example-plugin';
    expect(drawer(item).textContent).not.toContain(t('lowUse.providerMissing'));
  });
  it('saves validated numeric settings and keeps example mode read-only', async () => {
    vi.mocked(api).mockResolvedValue({});
    await act(async () => root.render(<SettingsPage ctx={ctx} />));
    const inputs = host.querySelectorAll<HTMLInputElement>('.low-use-settings input');
    expect([...inputs].map((i) => [i.min, i.max, i.value])).toEqual([
      ['1', '50', '10'],
      ['30', '360', '60'],
    ]);
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(api).toHaveBeenCalledWith(
      '/settings',
      { low_use_threshold: 10, low_use_window_minutes: 60 },
      'PUT',
    );
    expect(ctx.reload).toHaveBeenCalledOnce();
    ctx.demo = true;
    await act(async () => root.render(<SettingsPage ctx={{ ...ctx }} />));
    expect(host.querySelector<HTMLButtonElement>('.low-use-settings button')!.disabled).toBe(true);
    expect(
      [...host.querySelectorAll<HTMLInputElement>('.low-use-settings input')].every(
        (i) => i.disabled,
      ),
    ).toBe(true);
  });
  it('shows a failed settings save without claiming success', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Save failed'));
    await act(async () => root.render(<SettingsPage ctx={ctx} />));
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Save failed');
    expect(ctx.notify).not.toHaveBeenCalled();
  });
});
