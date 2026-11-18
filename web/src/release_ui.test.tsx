// @vitest-environment jsdom
import { serverDashboard, serverDemo } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { groupsOf } from './groups';
import { dateTime } from './domain';
import { setLocale, t } from './i18n';
import { comparePlans, planOptions } from './plan';
import { planFactors } from './planExplanation';
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

/** An option's row and the explanation row under it, where its reasons are kept. */
function optionText(row: Element) {
  return `${row.textContent}${row.nextElementSibling?.textContent ?? ''}`;
}

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
      expect(optionText(row)).toContain(
        `${t('plan.why.busy', { free: 0 })}${locale === 'zh-CN' ? '' : ' '}${sentence}`,
      );
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
    const free = page(html).querySelector('.plan-factors dd')!;
    expect(free.textContent).toContain(t('plan.why.degraded'));
    expect(free.textContent).toContain(t('plan.effect.lowers'));
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
  it.each(['QOSMaxGRESPerUser', 'QOSMaxJobsPerUserLimit', 'AssocMaxJobsLimit'])(
    'explains %s and translates the queue class with the raw code on hover',
    (reason) => {
      setLocale(locale);
      const root = page(renderPlan(source, [pending({ gpu_count: 1, reason })]));
      const row = root.querySelector('.plan-table tbody tr')!;
      expect(row.querySelector('.plan-verdict .status')!.textContent).toBe(
        t('plan.verdict.possible'),
      );
      const why = t('plan.why.contradiction', { job: 'train', reason });
      // The verdict stays in the row; its reason is one click away, in the row's disclosure.
      expect(row.textContent).not.toContain(why);
      const explanation = row.nextElementSibling!.querySelector('.plan-explanation')!;
      expect(explanation.textContent).toContain(why);
      // The Queued cell holds one value, the count; the translated class lives in the
      // disclosure, with the raw scheduler code on hover.
      const queue = row.querySelector(`[data-label="${t('plan.col.queued')}"]`)!;
      expect(queue.textContent).toBe('1');
      expect(row.textContent).not.toContain(reason);
      const label = explanation.querySelector('p[title]')!;
      expect(label.getAttribute('title')).toBe(reason);
      expect(label.textContent).toBe(t('plan.queueReason.personalLimit'));
      expect(root.querySelector('.plan-best')!.textContent).toContain(t('plan.verdict.possible'));
    },
  );

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
    expect(optionText(row)).toContain(
      t(`plan.why.${kind}`, { limit: 1, used: kind === 'jobs' ? 1 : 2 }),
    );
    expect(optionText(row)).not.toContain(t('plan.why.contradiction', { job: 'train', reason }));
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
      // The reason sits in the option's disclosure; the raw code stays reachable on hover.
      const row = root.querySelector('.plan-table tbody tr.plan-option-row')!;
      const explanation = row.nextElementSibling!.querySelector('.plan-explanation')!;
      const label = explanation.querySelector('p[title]')!;
      expect(label.getAttribute('title')).toBe(reason);
      expect(label.textContent).toBe(key ? t(key) : reason);
      expect(explanation.textContent).not.toContain(t('job.explain.unknown'));
      expect(row.textContent).not.toContain(reason);
      if (key && t(key) !== reason) expect(explanation.textContent).not.toContain(reason);
    },
  );

  it('shows unknown access inline, explains it in each option disclosure and recommends none', () => {
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
    expect(root.querySelector('details.panel')).toBeNull();
    expect(root.querySelectorAll('.plan-table tbody tr:not(.plan-explanation-row)')).toHaveLength(
      2,
    );
    const note = t('plan.accessNote', { source: 'Cluster A · alice' });
    // No panel-wide note: each unchecked option reads Unknown and explains in its disclosure.
    expect(
      [...root.querySelectorAll('.panel-note')].some((el) => el.textContent?.includes(note)),
    ).toBe(false);
    for (const row of root.querySelectorAll('.plan-table tbody tr:not(.plan-explanation-row)')) {
      const status = row.querySelector('.plan-verdict .status')!;
      expect(status.textContent).toBe(t('plan.verdict.unknown'));
      expect(status.classList.contains('gray')).toBe(true);
      expect(row.textContent).not.toContain(t('plan.verdict.possible'));
      expect(row.nextElementSibling!.querySelector('.plan-explanation')!.textContent).toContain(
        note,
      );
    }
    // An unchecked option is not offered as the best estimate.
    expect(root.querySelector('.plan-best')).toBeNull();
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
    // The room tile stays unknown rather than inventing a number.
    expect(root.querySelectorAll('.plan-best .figures dd')[1].textContent).toBe('—');
    const stale = page(renderPlan({ ...source, stale: true }, [pending()]));
    const staleRow = stale.querySelector('.plan-table tbody tr.plan-option-row')!;
    expect(staleRow.querySelector(`[data-label="${t('plan.col.queued')}"]`)!.textContent).toBe('—');
    expect(staleRow.nextElementSibling!.textContent).toContain(t('plan.queueRoomUnknown'));
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
      expect(optionText(row)).toContain(t('plan.why.behind', { queued: 2, left: 2 }));
      expect(optionText(row)).toContain(t('plan.queuedGpus', { count: 2 }));
      expect(optionText(row)).not.toContain(t('plan.queuedGpus', { count: 10 }));
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
    expect(root.querySelector('details.panel')!.textContent).toContain('denied');
    expect(root.querySelector('details.panel')!.hasAttribute('open')).toBe(false);
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
    const first = root.querySelector('.plan-table tbody tr.plan-option-row')!;
    expect(first.querySelector(`td[data-label="${t('job.qos')}"]`)!.textContent).toBe(
      options[0].qos,
    );
    expect(first.querySelector(`td[data-label="${t('sources.col.login')}"]`)!.textContent).toBe(
      options[0].source.username,
    );
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
    // The first tile is free GPUs after this request, still a lower bound.
    expect(best.querySelector('.figures dt')!.textContent).toBe(t('plan.tile.free'));
    expect(best.querySelector('.figures dd')!.textContent).toBe('≥ 3');
  },
);

describe.each(['en', 'zh-CN'] as const)('expandable plan factors in %s', (locale) => {
  it('offers all seven factors on every option, including denied options, with source and age', () => {
    setLocale(locale);
    const login = {
      ...source,
      qos: [
        ...source.qos,
        { ...source.qos[0], name: 'restricted', access: 'not_associated' as const },
      ],
    };
    const ctx = planContext(login);
    const root = page(renderToStaticMarkup(<PlanPage ctx={ctx} />));
    const options = planOptions(ctx.data, { gpus: 1, gpuType: '', hours: null });
    const details = root.querySelectorAll<HTMLElement>('.plan-explanation');
    expect(details).toHaveLength(options.length);
    for (const panel of details) {
      // Closed until its row's chevron (or the row) is used; no repeated text line.
      const row = panel.closest('tr')!;
      expect(row.hidden).toBe(true);
      const toggle = root.querySelector(`[aria-controls="${row.id}"]`)!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toContain(' · ');
      expect(panel.querySelectorAll('dt')).toHaveLength(7);
      for (const field of panel.querySelectorAll('dd')) {
        expect(field.textContent).toContain('Cluster A · alice');
        expect(field.querySelector('time')!.getAttribute('datetime')).toBe(source.last_success);
        expect(field.querySelector('time')!.textContent).toBe(dateTime(source.last_success));
        expect(field.querySelector('time')!.textContent).not.toBe(source.last_success);
      }
    }
    expect(details[0].textContent).toContain(t('plan.factor.wallUnchecked'));
    expect(details[1].textContent).toContain(t('plan.factor.access.not_associated'));
  });

  it('distinguishes an empty run time from an unknown maximum', () => {
    setLocale(locale);
    const request = { gpus: 1, gpuType: '', hours: null };
    const [option] = planOptions(planContext(source).data, request);
    for (const max of [24, null]) {
      for (const hours of [null, 0, 2]) {
        const factor = planFactors({ ...option, maxWallHours: max }, { ...request, hours }).find(
          (factor) => factor.key === 'wall',
        )!;
        const unchecked = hours == null || max == null;
        expect(factor.value).toBe(
          t('plan.factor.wallValue', {
            max: max == null ? t('status.unknown') : t('plan.hours', { count: max }),
            requested:
              hours == null ? t('plan.factor.notEntered') : t('plan.hours', { count: hours }),
          }) + (unchecked ? ` ${t('plan.factor.wallUnchecked')}` : ''),
        );
        expect(factor.effect).toBe(unchecked ? 'neutral' : 'supports');
      }
    }
  });

  it.each([
    ['100', 1.7],
    ['00:20:00', 0.3],
  ])('rounds a %s wall limit and requested hours like the table', (max, rounded) => {
    setLocale(locale);
    const ctx = planContext({
      ...source,
      qos: [{ ...source.qos[0], limits: { ...source.qos[0].limits, MaxWallPJ: max } }],
    });
    const request = { gpus: 1, gpuType: '', hours: 1 / 3 };
    const [option] = planOptions(ctx.data, request);
    const factor = planFactors(option, request).find((factor) => factor.key === 'wall')!;
    expect(factor.value).toBe(
      locale === 'en'
        ? `Maximum run time: ${rounded} h; requested: 0.3 h.`
        : `最长运行时间：${rounded} 小时；请求时间：0.3 小时。`,
    );
    const root = page(renderToStaticMarkup(<PlanPage ctx={ctx} />));
    const wall = root.querySelector(`[data-label="${t('plan.col.wall')}"]`)!;
    expect(wall.textContent).toBe(t('plan.hours', { count: rounded }));
    expect(root.querySelector('.plan-factors')!.textContent).toContain(wall.textContent);
  });

  it('labels unknown and unlimited queue counts without attaching GPU units to their values', () => {
    setLocale(locale);
    const request = { gpus: 1, gpuType: '', hours: null };
    const [option] = planOptions(planContext(source).data, request);
    for (const room of [null, Infinity]) {
      const factor = planFactors(
        { ...option, queuedForRoom: null, headroomAfterQueue: room },
        request,
      ).find((factor) => factor.key === 'queue')!;
      const value = room == null ? t('status.unknown') : t('plan.noLimit');
      expect(factor.value).toContain(
        locale === 'en' ? `room after queue (GPUs): ${value}` : `队列之后剩余（GPU）：${value}`,
      );
      expect(factor.value).not.toMatch(/(?:未知|不限) 张 GPU/);
    }
  });

  it.each([false, true])(
    'explains unavailable clusters only with current nodes (stale: %s)',
    (stale) => {
      setLocale(locale);
      const ctx = planContext({ ...source, cluster_state: 'unavailable', stale });
      ctx.data.nodes = [];
      const request = { gpus: 1, gpuType: '', hours: null };
      const [option] = planOptions(ctx.data, request);
      expect(option.freeGpus).toBeNull();
      if (!stale) expect(option.verdict).toBe('unavailable');
      const free = planFactors(option, request).find((factor) => factor.key === 'free')!;
      expect(free.effect).toBe(stale ? 'unknown' : 'lowers');
      expect(free.value.includes(t('plan.why.unavailable'))).toBe(!stale);
      const root = page(renderToStaticMarkup(<PlanPage ctx={ctx} />));
      expect(root.querySelector('.plan-factors dd')!.textContent).toContain(
        t(stale ? 'plan.effect.unknown' : 'plan.effect.lowers'),
      );
    },
  );

  it('explains unknowns, partial capacity, limits, runtime and the contradiction cap without changing verdicts', () => {
    setLocale(locale);
    const request = { gpus: 1, gpuType: '', hours: 25 };
    const ctx = planContext({
      ...source,
      qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu=8', MaxWallPJ: '1440' } }],
    });
    const [option] = planOptions(ctx.data, request);
    const factors = planFactors(option, request);
    expect(option.verdict).toBe('wall');
    expect(factors.find((factor) => factor.key === 'wall')!.effect).toBe('lowers');
    expect(factors.find((factor) => factor.key === 'oneNode')!.effect).toBe('ranking');
    const [contradiction] = planOptions(
      planContext(source, [pending({ gpu_count: 1, reason: 'AssocMaxJobsLimit' })]).data,
      { ...request, hours: null },
    );
    expect(contradiction.verdict).toBe('possible');
    expect(
      planFactors(contradiction, request).find((factor) => factor.key === 'queue'),
    ).toMatchObject({ effect: 'lowers' });
    expect(
      planFactors(contradiction, request).find((factor) => factor.key === 'queue')!.value,
    ).toContain('AssocMaxJobsLimit');
    const [unknown] = planOptions(planContext({ ...source, stale: true }).data, request);
    for (const key of ['free', 'limit', 'queue', 'wall']) {
      expect(planFactors(unknown, request).find((factor) => factor.key === key)!.value).toContain(
        t('status.unknown'),
      );
    }
    expect(planFactors({ ...option, freeGpusPartial: true }, request)[0].value).toContain('≥ 4');
    const [limited] = planOptions(
      planContext({
        ...source,
        qos: [{ ...source.qos[0], limits: { MaxTRESPU: 'gres/gpu=8', MaxJobsPU: '0' } }],
      }).data,
      request,
    );
    expect(planFactors(limited, request).find((factor) => factor.key === 'limit')).toMatchObject({
      effect: 'lowers',
    });
  });

  it('compares the actual first two visible options and explains equal ranking honestly', () => {
    setLocale(locale);
    const ctx = planContext({
      ...source,
      qos: [...source.qos, { ...source.qos[0], name: 'other' }],
    });
    const request = { gpus: 1, gpuType: '', hours: null };
    const [best, next] = planOptions(ctx.data, request);
    expect(comparePlans(best, next, request).factor).toBe('tie');
    const root = page(renderToStaticMarkup(<PlanPage ctx={ctx} />));
    expect(root.querySelector('.plan-comparison')!.textContent).toBe(
      t('plan.compare.tie', { other: 'Cluster A · alice · other' }),
    );
    const single = page(renderPlan(source));
    expect(single.querySelector('.plan-comparison')).toBeNull();
  });

  it.each([
    'verdict',
    'none',
    'noGpus',
    'oneNode',
    'unknownFit',
    'queue',
    'unlimited',
    'unknownRoom',
    'free',
    'access',
  ] as const)('renders both values and the first differing factor for %s', async (scenario) => {
    setLocale(locale);
    const ctx = planContext({ ...source, cluster_state: 'degraded' });
    const first = ctx.data.sources[0];
    const second: Source = {
      ...first,
      id: 'cluster-b-bob',
      name: 'Cluster B',
      cluster_id: 'cluster-b',
      username: 'bob',
      qos: [{ ...first.qos[0] }],
    };
    const firstNode = { ...ctx.data.nodes[0], gpu_count: 8 };
    const secondNode = {
      ...firstNode,
      id: 'cluster-b:gpu-1',
      source_id: second.id,
      cluster_id: second.cluster_id,
    };
    ctx.data.sources = [first, second];
    ctx.data.nodes = [firstNode, secondNode];
    let factor: 'verdict' | 'oneNode' | 'queue' | 'free' | 'access' = 'verdict';
    let best = t('plan.verdict.possible');
    let next = t('plan.verdict.busy');
    switch (scenario) {
      case 'verdict':
        secondNode.gpu_allocated = 8;
        break;
      case 'none':
      case 'noGpus':
        if (scenario === 'none') firstNode.gpu_type = 'H100';
        else secondNode.gpu_count = 0;
        next =
          scenario === 'none'
            ? t('plan.verdict.none', { model: 'H100' })
            : t('plan.verdict.noGpus');
        break;
      case 'oneNode':
      case 'unknownFit':
        factor = 'oneNode';
        best = t('plan.compare.fits');
        if (scenario === 'oneNode') {
          secondNode.gpu_count = 2;
          ctx.data.nodes.push({ ...secondNode, id: 'cluster-b:gpu-2', name: 'gpu-2' });
          next = t('plan.compare.notFit');
        } else {
          secondNode.state = 'new_scheduler_state';
          next = t('status.unknown');
        }
        break;
      case 'queue':
      case 'unlimited':
      case 'unknownRoom':
        factor = 'queue';
        first.qos = [
          {
            ...first.qos[0],
            limits: { MaxTRESPU: scenario === 'unlimited' ? 'gres/gpu=N' : 'gres/gpu=16' },
          },
        ];
        best = scenario === 'unlimited' ? t('plan.noLimit') : '16';
        next = '8';
        if (scenario === 'unknownRoom') {
          second.qos = [{ ...second.qos[0], limits: {} }];
          next = t('status.unknown');
        }
        break;
      case 'free':
        factor = 'free';
        ctx.data.nodes.push(
          { ...firstNode, id: 'cluster-a:gpu-2', name: 'gpu-2', gpu_count: 4 },
          { ...firstNode, id: 'cluster-a:unknown', name: 'unknown', state: 'new_scheduler_state' },
        );
        best = '≥ 12';
        next = '8';
        break;
      case 'access':
        factor = 'access';
        second.qos = [{ ...second.qos[0], access: 'unknown' }];
        best = t('plan.compare.verified');
        next = t('plan.compare.accessUnknown');
        break;
    }
    ctx.data = serverDashboard(ctx.data);
    ctx.groups = groupsOf(ctx.data);
    const previous = window.location.href;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      window.history.replaceState(
        null,
        '',
        `#/plan?gpus=4${scenario === 'none' ? '&model=H100' : ''}`,
      );
      await act(async () => root.render(<PlanPage ctx={ctx} />));
      expect(container.querySelector('.plan-comparison')!.textContent).toBe(
        t('plan.compare.reason', {
          other: 'Cluster B · bob · normal',
          factor: t(`plan.compare.${factor}`),
          best,
          next,
        }),
      );
    } finally {
      await act(async () => root.unmount());
      window.history.replaceState(null, '', previous);
    }
  });

  it('labels limits and jobs separately when their observation times differ', () => {
    setLocale(locale);
    const observed = '2026-01-01T00:00:00Z';
    const ctx = planContext(source, [pending({ observed_at: observed, gpu_count: 1 })]);
    const root = page(renderToStaticMarkup(<PlanPage ctx={ctx} />));
    const factor = [...root.querySelectorAll('.plan-factors > div')].find(
      (row) => row.querySelector('dt')!.textContent === t('plan.factor.limit'),
    )!;
    for (const [capability, at] of [
      ['qos_limits', source.last_success!],
      ['jobs', observed],
    ] as const) {
      const line = [...factor.querySelectorAll('dd > span')].find(
        (span) =>
          span.querySelector('time') &&
          span.textContent?.includes(t(`plan.factor.capability.${capability}`)),
      )!;
      expect(line.textContent).toContain('Cluster A · alice');
      expect(line.querySelector('time')!.getAttribute('datetime')).toBe(at);
    }
  });

  it('demonstrates different data ages and an unknown runtime in example mode', () => {
    setLocale(locale);
    const data = serverDemo();
    const request = { gpus: 1, gpuType: '', hours: null };
    const options = planOptions(data, request);
    const bob = options.find(
      (option) => option.source.id === 'example:cluster-a-bob' && option.qos === 'debug',
    )!;
    expect(bob.maxWallHours).toBeNull();
    expect(bob.evidence.nodes[0].at).not.toBe(bob.evidence.limits[0].at);
    expect(planFactors(bob, request).find((factor) => factor.key === 'wall')!.value).toContain(
      t('status.unknown'),
    );
  });
});

describe.each(['en', 'zh-CN'] as const)('plan disclosure interaction in %s', (locale) => {
  it('opens and closes from the row, retaining an open panel while polled evidence changes', async () => {
    setLocale(locale);
    const ctx = planContext(source);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<PlanPage ctx={ctx} />));
      const toggle = container.querySelector<HTMLButtonElement>('.plan-expand')!;
      const details = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(details.hidden).toBe(true);
      await act(async () => toggle.click());
      expect(details.hidden).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(details.querySelector('dd')!.textContent).toContain(
        t('plan.factor.freeValue', { count: '4' }),
      );
      const updated = {
        ...ctx,
        data: { ...ctx.data, nodes: ctx.data.nodes.map((node) => ({ ...node, gpu_allocated: 1 })) },
      };
      await act(async () => root.render(<PlanPage ctx={updated} />));
      expect(details.hidden).toBe(false);
      expect(details.querySelector('dd')!.textContent).toContain(
        t('plan.factor.freeValue', { count: '3' }),
      );
      // The whole row toggles too.
      await act(async () => (details.previousElementSibling as HTMLElement).click());
      expect(details.hidden).toBe(true);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
