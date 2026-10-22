// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { machineOptions, machineSamples, lowUseInstances } from './plan';
import { CloudPage } from './pages/Cloud';
import { InstanceDetail } from './pages/Details';
import type { Ctx } from './pages/shared';
import { serverDashboard, serverDemo } from './test-server';

let demo: ReturnType<typeof serverDemo>;
beforeAll(() => {
  demo = serverDemo();
});
afterEach(() => {
  setLocale('en');
});

function fixture() {
  const data = structuredClone(demo);
  const item = data.instances.find((i) => i.name === 'node-console')!;
  const ctx = {
    data,
    groups: groupsOf(data),
    group: 'all',
    query: '',
    demo: false,
    searchRef: { current: null },
    setQuery: vi.fn(),
    setGroup: vi.fn(),
  } as unknown as Ctx;
  return { data, item, ctx };
}

function element(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe.each(['en', 'zh-CN'] as const)('machine/node identity in %s', (locale) => {
  it('explains the scheduler count on the machine row and keeps hardware checks enabled', () => {
    setLocale(locale);
    const { item, ctx } = fixture();
    const note = t('instance.sameNode', { node: 'a-gpu-01', cluster: 'Cluster A' });
    const page = element(renderToStaticMarkup(<CloudPage ctx={ctx} />));
    const row = [...page.querySelectorAll('tbody tr')].find((r) =>
      r.textContent?.includes(item.name),
    )!;
    expect(row.textContent).toContain(note);
    const detail = element(
      renderToStaticMarkup(
        <InstanceDetail
          item={item}
          ctx={ctx}
          onProbe={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    expect(detail.textContent).toContain(note);
    const probe = [...detail.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(t('instance.probe')),
    )!;
    expect(probe).toBeTruthy();
    expect(probe.disabled).toBe(false);
    expect(detail.textContent).toContain(t('instance.gpusBusy'));
  });

  it('removes scheduler-managed SSH machines from free-machine options and stale hints', () => {
    const { data } = fixture();
    const machine = data.instances.find((i) => i.name === 'lab-server')!;
    expect(machineOptions(data, { gpus: 1, gpuType: '', hours: null })).toHaveLength(1);
    machine.ssh_endpoint = { host: '192.0.2.31', port: 22 };
    const linked = serverDashboard(data);
    const item = linked.instances.find((i) => i.id === machine.id)!;
    expect(item.same_node?.name).toBe('a-gpu-01');
    expect(machineOptions(linked, { gpus: 1, gpuType: '', hours: null })).toEqual([]);
    item.gpus_observed_at = null;
    expect(machineSamples(linked)).toEqual({ current: [], staleCount: 0 });
    item.hourly_cost = 1;
    item.low_use = {
      state: 'low',
      since: null,
      covered_minutes: 60,
      samples: 7,
      origin: 'source',
      reason: null,
    };
    expect(lowUseInstances([item])).toEqual([]);
    expect(linked.summary.unmeasured.some((r) => r.subject.id === item.id)).toBe(false);
  });
});
