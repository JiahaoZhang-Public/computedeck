// @vitest-environment jsdom
import { serverDashboard, serverDemo } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { planOptions } from './plan';
import { PlanPage } from './pages/Plan';
import type { Ctx } from './pages/shared';
import type { Dashboard, Job, Source } from './types';

const source: Source = {
  id: 'cluster-a-alice',
  name: 'Cluster A',
  driver: 'slurm',
  kind: 'cluster',
  cluster_id: 'cluster-a',
  username: 'alice',
  ssh_alias: 'cluster-a',
  credential: '',
  enabled: true,
  status: 'ready',
  last_success: new Date().toISOString(),
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: ['jobs', 'nodes', 'qos_limits', 'qos_access'],
  qos: [
    { name: 'normal', access: 'verified', limits: { MaxTRESPU: 'gres/gpu=8' }, origin: 'test' },
  ],
};

function renderPlan(login: Source, jobs: Job[] = []) {
  const data: Dashboard = serverDashboard({
    mode: 'live',
    sources: [login],
    jobs,
    instances: [],
    nodes: [
      {
        id: 'cluster-a:gpu-1',
        source_id: login.id,
        cluster_id: login.cluster_id,
        name: 'gpu-1',
        state: 'idle',
        gpu_count: 4,
        gpu_allocated: 0,
        gpu_type: 'A100',
        cpu_count: 32,
        cpu_allocated: 0,
        partitions: ['gpu'],
        observed_at: login.last_success,
      },
    ],
    history: [],
    updated_at: null,
    refreshing: false,
  });
  const ctx = { data, groups: groupsOf(data), demo: false } as unknown as Ctx;
  return renderToStaticMarkup(<PlanPage ctx={ctx} />);
}

afterEach(() => setLocale('en'));

describe.each(['en', 'zh-CN'] as const)('planner explanations in %s', (locale) => {
  it('explains degradation without saying a known QoS limit is unknown', () => {
    setLocale(locale);
    const html = renderPlan({ ...source, cluster_state: 'degraded' });
    expect(html).toContain(t('plan.verdict.possible'));
    expect(html).toContain(t('plan.why.degraded'));
    expect(html).not.toContain(t('plan.why.possibleLimit', { free: 4 }));
  });

  it('explains unknown access separately from a known QoS limit', () => {
    setLocale(locale);
    const html = renderPlan({
      ...source,
      qos: [{ ...source.qos[0], access: 'unknown' }],
    });
    expect(html).toContain(t('plan.accessNote', { source: 'Cluster A · alice' }));
    expect(html).not.toContain(t('plan.why.possibleLimit', { free: 4 }));
  });

  it('still explains when the QoS limit really is unknown', () => {
    setLocale(locale);
    const html = renderPlan({ ...source, qos: [{ ...source.qos[0], limits: {} }] });
    expect(html).toContain(t('plan.why.possibleLimit', { free: 4 }));
  });
});

const pending = (extra: Partial<Job> = {}): Job => ({
  id: 'cluster-a:1',
  source_id: source.id,
  cluster_id: source.cluster_id,
  name: 'train',
  user: 'alice',
  account: '',
  partition: 'gpu',
  qos: 'normal',
  state: 'PENDING',
  gpu_count: 8,
  gpu_type: 'A100',
  cpu_count: 8,
  node: null,
  elapsed: '',
  reason: 'Priority',
  gpu_utilization: null,
  cpu_utilization: null,
  memory_utilization: null,
  observed_at: source.last_success,
  ...extra,
});
function page(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe.each(['en', 'zh-CN'] as const)('honest planner presentation in %s', (locale) => {
  it('shows unknown access inline, with one note per source and a tagged best estimate', () => {
    setLocale(locale);
    const root = page(
      renderPlan({
        ...source,
        qos: ['normal', 'long'].map((name) => ({
          ...source.qos[0],
          name,
          access: 'unknown',
        })),
      }),
    );
    expect(root.querySelector('details')).toBeNull();
    expect(root.querySelectorAll('.plan-table tbody tr')).toHaveLength(2);
    const note = t('plan.accessNote', { source: 'Cluster A · alice' });
    expect(
      [...root.querySelectorAll('.panel-note')].filter((el) => el.textContent === note),
    ).toHaveLength(1);
    const best = root.querySelector('.plan-best')!;
    expect(best.textContent).toContain(t('plan.accessUnchecked'));
    expect(best.textContent).toContain(t('plan.verdict.possible'));
    const first = root.querySelector('.plan-table tbody tr')!;
    expect(best.querySelector('strong')!.textContent).toContain(
      first.querySelector('.plan-qos')!.textContent,
    );
  });

  it('uses a wait tone and no best card when the queue consumes the room', () => {
    setLocale(locale);
    const root = page(renderPlan(source, [pending()]));
    expect(root.querySelector('.plan-best')).toBeNull();
    const status = root.querySelector('.plan-verdict .status')!;
    expect(status.classList.contains('wait')).toBe(true);
    expect(status.classList.contains('amber')).toBe(false);
    expect(status.querySelector('svg')).not.toBeNull();
    expect(status.textContent).toBe(t('plan.verdict.behind'));
    expect(root.textContent).toContain(t('plan.why.behind', { queued: 8, left: 0 }));
  });

  it('shows unknown demand without inventing zero or a likely verdict', () => {
    setLocale(locale);
    const root = page(renderPlan(source, [pending({ gpu_count: null })]));
    expect(root.textContent).toContain(t('plan.queuedGpus', { count: '—' }));
    expect(root.textContent).toContain(t('plan.why.queueUnknown'));
    expect(root.textContent).not.toContain(t('plan.verdict.likely'));
    expect(root.querySelector('.plan-best')!.textContent).toContain(
      t('plan.best.room', { count: '—' }),
    );
    const stale = page(renderPlan({ ...source, stale: true }, [pending()]));
    expect(stale.querySelector('[data-label="' + t('plan.col.queued') + '"]')!.textContent).toBe(
      '—' + t('plan.queuedGpus', { count: '—' }),
    );
    expect(stale.textContent).not.toContain('Priority');
  });

  it.each([
    { qos: [{ ...source.qos[0], access: 'not_associated' as const }] },
    { qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu=0' } }] },
    { qos: [{ ...source.qos[0], limits: { GrpTRES: 'gres/gpu=0' } }] },
    { stale: true },
    { cluster_state: 'unavailable' as const },
  ])('does not recommend an ineligible option: %j', (extra) => {
    setLocale(locale);
    expect(page(renderPlan({ ...source, ...extra })).querySelector('.plan-best')).toBeNull();
  });

  it('keeps denied options collapsed and out of the best estimate', () => {
    setLocale(locale);
    const root = page(
      renderPlan({
        ...source,
        qos: [{ ...source.qos[0], name: 'denied', access: 'not_associated' }, source.qos[0]],
      }),
    );
    expect(root.querySelector('details')!.textContent).toContain('denied');
    expect(root.querySelector('details')!.hasAttribute('open')).toBe(false);
    expect(root.querySelector('.plan-best')!.textContent).toContain('normal');
    expect(root.querySelector('.plan-best')!.textContent).not.toContain('denied');
  });

  it('uses row one for the example best estimate and shows its queue waits', () => {
    setLocale(locale);
    const data = serverDemo();
    const options = planOptions(data, { gpus: 1, gpuType: '', hours: null });
    expect(options.some((option) => option.verdict === 'behind')).toBe(true);
    const root = page(
      renderToStaticMarkup(<PlanPage ctx={{ data, groups: groupsOf(data), demo: true } as Ctx} />),
    );
    const best = root.querySelector('.plan-best')!;
    expect(best.querySelector('strong')!.textContent).toBe(
      `${options[0].source.name} · ${options[0].source.username} · ${options[0].qos}`,
    );
    expect(root.querySelector('.plan-table tbody tr .plan-qos')!.textContent).toBe(options[0].qos);
  });
});
