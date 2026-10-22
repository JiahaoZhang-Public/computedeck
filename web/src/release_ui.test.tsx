// @vitest-environment jsdom
import { serverDashboard, serverDemo } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { planOptions } from './plan';
import { PlanPage } from './pages/Plan';
import type { Ctx } from './pages/shared';
import type { Dashboard, Job, QosLimit, Source } from './types';

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

function planContext(login: Source, jobs: Job[] = []) {
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
  return { data, groups: groupsOf(data), demo: false } as unknown as Ctx;
}

function renderPlan(login: Source, jobs: Job[] = []) {
  return renderToStaticMarkup(<PlanPage ctx={planContext(login, jobs)} />);
}

afterEach(() => setLocale('en'));

describe.each(['en', 'zh-CN'] as const)('planner explanations in %s', (locale) => {
  it('shows a complete on-demand sentence after the reason, only for the selected model', async () => {
    setLocale(locale);
    const context = planContext(source);
    context.data.nodes[0].state = 'IDLE+CLOUD+POWERED_DOWN';
    context.data = serverDashboard(context.data);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const previous = window.location.href;
    try {
      window.history.replaceState(null, '', '#/plan?model=A100');
      await act(async () => root.render(<PlanPage ctx={context} />));
      const sentence = t('plan.why.onDemand', { count: 4 });
      const row = container.querySelector('.plan-table tbody tr')!;
      expect(row.textContent).toContain(`${t('plan.why.busy', { free: 0 })} ${sentence}`);
      expect(sentence).toMatch(/[.。]$/);
      await act(async () => {
        window.history.replaceState(null, '', '#/plan?model=H100');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(container.textContent).not.toContain(sentence);
      expect(container.textContent).not.toContain(t('summary.onDemand', { count: 4 }));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      window.history.replaceState(null, '', previous);
    }
  });

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
  it('explains a contradiction and translates the queue class with the raw code on hover', () => {
    setLocale(locale);
    const reason = 'QOSMaxGRESPerUser';
    const root = page(renderPlan(source, [pending({ gpu_count: 1, reason })]));
    const row = root.querySelector('.plan-table tbody tr')!;
    expect(row.querySelector('.plan-verdict .status')!.textContent).toBe(
      t('plan.verdict.possible'),
    );
    expect(row.textContent).toContain(t('plan.why.contradiction', { job: 'train', reason }));
    const queue = row.querySelector(`[data-label="${t('plan.col.queued')}"]`)!;
    expect(queue.querySelector('[title]')!.getAttribute('title')).toBe(reason);
    expect(queue.textContent).toContain(t('plan.queueReason.personalLimit'));
    expect(queue.textContent).not.toContain(reason);
    expect(root.querySelector('.plan-best')!.textContent).toContain(t('plan.verdict.possible'));
  });

  it.each([
    ['MaxJobsPU', 'QOSMaxJobsPerUserLimit', 'jobs'],
    ['MaxSubmitJobsPU', 'QOSMaxSubmitJobPerUserLimit', 'submit'],
  ] as const)('does not claim room when %s is reached', (key, reason, kind) => {
    setLocale(locale);
    const login = {
      ...source,
      qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu=8', [key]: '1' } }],
    };
    const root = page(
      renderPlan(login, [
        pending({ id: 'running', state: 'RUNNING', gpu_count: 1 }),
        pending({ gpu_count: 1, reason }),
      ]),
    );
    const row = root.querySelector('.plan-table tbody tr')!;
    expect(row.querySelector('.plan-verdict .status')!.textContent).toBe(t('plan.verdict.limit'));
    expect(row.textContent).toContain(
      t(`plan.why.${kind}`, { limit: 1, used: kind === 'jobs' ? 1 : 2 }),
    );
    expect(row.textContent).not.toContain(t('plan.why.contradiction', { job: 'train', reason }));
  });

  it.each([
    ['slurm', 'SiteSpecificCode', null],
    ['pbs', 'Not Running: Insufficient amount of resource: ngpus', null],
    ['slurm', 'Priority', 'plan.queueReason.priority'],
  ] as const)(
    'preserves reported %s reasons unless a class is recognised: %s',
    (driver, reason, key) => {
      setLocale(locale);
      const root = page(renderPlan({ ...source, driver }, [pending({ gpu_count: 1, reason })]));
      const queue = root.querySelector(`[data-label="${t('plan.col.queued')}"]`)!;
      const label = queue.querySelector('[title]')!;
      expect(label.getAttribute('title')).toBe(reason);
      expect(label.textContent).toBe(key ? t(key) : reason);
      expect(queue.textContent).not.toContain(t('job.explain.unknown'));
      if (key && t(key) !== reason) expect(queue.textContent).not.toContain(reason);
    },
  );

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

  it('uses singular GPU units for one GPU of queue room', () => {
    setLocale(locale);
    const login = {
      ...source,
      qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu=1' } }],
    };
    const root = page(renderPlan(login, [pending({ gpu_count: 1 })]));
    expect(root.textContent).toContain(t('plan.queuedGpus', { count: 1 }));
    expect(root.textContent).toContain(t('plan.why.behind', { count: 1, queued: 1, left: 0 }));
    expect(root.textContent).not.toContain('1 GPUs');
  });

  it('shows unknown demand without inventing zero or a likely verdict', () => {
    setLocale(locale);
    const root = page(renderPlan(source, [pending({ gpu_count: null })]));
    expect(root.textContent).toContain(t('plan.queueRoomUnknown'));
    expect(root.textContent).not.toContain('— GPUs');
    expect(root.textContent).toContain(t('plan.why.queueUnknown'));
    expect(root.textContent).not.toContain(t('plan.verdict.likely'));
    expect(root.querySelector('.plan-best')!.textContent).toContain(
      t('plan.best.room', { count: '—' }),
    );
    const stale = page(renderPlan({ ...source, stale: true }, [pending()]));
    expect(stale.querySelector('[data-label="' + t('plan.col.queued') + '"]')!.textContent).toBe(
      '—' + t('plan.queueRoomUnknown'),
    );
    expect(stale.textContent).not.toContain('Priority');
    expect(stale.textContent).not.toContain(t('plan.why.queueUnknown'));
  });

  it('shows matching queue arithmetic for a model-specific limit', async () => {
    setLocale(locale);
    const ctx = planContext(
      {
        ...source,
        qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu:a100=8' } }],
      },
      [
        pending({ id: 'running', state: 'RUNNING', gpu_count: 4 }),
        pending({ id: 'other-model', gpu_type: 'H100', gpu_count: 8 }),
        pending({ id: 'matching', gpu_count: 2 }),
      ],
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<PlanPage ctx={ctx} />));
      await act(async () => {
        const model = container.querySelector('select')!;
        model.value = 'A100';
        model.dispatchEvent(new Event('change', { bubbles: true }));
        const gpus = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(gpus, '4');
        gpus.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const row = container.querySelector('.plan-table tbody tr')!;
      expect(row.textContent).toContain(t('plan.verdict.behind'));
      expect(row.textContent).toContain(t('plan.why.behind', { queued: 2, left: 2 }));
      expect(row.textContent).toContain(t('plan.queuedGpus', { count: 2 }));
      expect(row.textContent).not.toContain(t('plan.queuedGpus', { count: 10 }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each<Partial<QosLimit>>([
    { access: 'not_associated' as const },
    { limits: { MaxTRESPU: 'gres/gpu=0' } },
    { limits: { GrpTRES: 'gres/gpu=0' } },
  ])('omits irrelevant queue uncertainty for an ineligible option: %j', (extra) => {
    setLocale(locale);
    const root = page(
      renderPlan({ ...source, qos: [{ ...source.qos[0], ...extra }] }, [
        pending({ gpu_count: null }),
      ]),
    );
    expect(root.textContent).not.toContain(t('plan.why.queueUnknown'));
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
    const held = data.jobs.find(
      (job) => job.reason === 'QOSMaxGRESPerUser' && job.gpu_count === 16,
    )!;
    const contradictory = options.find((option) => option.contradiction);
    expect(contradictory).toMatchObject({ queuedForRoom: 1, verdict: 'possible' });
    expect(
      options.find((option) => option.source.id === held.source_id && option.qos === held.qos),
    ).toMatchObject({ queuedForRoom: 0, verdict: 'likely' });
    const root = page(
      renderToStaticMarkup(<PlanPage ctx={{ data, groups: groupsOf(data), demo: true } as Ctx} />),
    );
    expect(root.textContent).toContain(t('plan.why.contradiction', contradictory!.contradiction!));
    const best = root.querySelector('.plan-best')!;
    expect(best.querySelector('strong')!.textContent).toBe(
      `${options[0].source.name} · ${options[0].source.username} · ${options[0].qos}`,
    );
    expect(root.querySelector('.plan-table tbody tr .plan-qos')!.textContent).toBe(options[0].qos);
  });
});

it.each(['en', 'zh-CN'] as const)(
  'renders partial free GPUs in the row and best estimate in %s',
  (locale) => {
    setLocale(locale);
    const context = planContext(source);
    context.data = serverDashboard({
      ...context.data,
      nodes: [
        context.data.nodes[0],
        {
          ...context.data.nodes[0],
          id: 'cluster-a:unknown',
          name: 'unknown',
          state: 'new_scheduler_state',
        },
      ],
    });
    const root = page(renderToStaticMarkup(<PlanPage ctx={context} />));
    const free = root.querySelector(`td[data-label="${t('plan.col.free')}"]`)!;
    expect(free.textContent).toContain('≥ 4');
    const best = root.querySelector('.plan-best')!;
    expect(best.textContent).toContain(t('plan.verdict.likely'));
    expect(best.textContent).toContain(t('plan.best.free', { count: '≥ 3' }));
  },
);
