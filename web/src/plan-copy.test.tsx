// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { PlanPage } from './pages/Plan';
import { JobDetail } from './pages/Details';
import type { Ctx } from './pages/shared';
import { planOptions } from './plan';
import { serverDemo } from './test-server';
import { routeParams, setRouteParams } from './useRouteParam';

let root: Root;
let host: HTMLDivElement;
let ctx: Ctx;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  window.history.replaceState(null, '', '/?demo=true#/plan');
  const data = serverDemo();
  ctx = { data, groups: groupsOf(data), copy: vi.fn(), demo: false } as unknown as Ctx;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setLocale('en');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<PlanPage ctx={ctx} />));
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.plan-submit button')];

it.each(['en', 'zh-CN'] as const)(
  'copies flags with the explicit copy-only toast and visible notes (%s)',
  async (locale) => {
    setLocale(locale);
    await render();
    expect(buttons().length).toBeGreaterThan(1);
    expect(host.querySelector('.plan-best .plan-submit')).not.toBeNull();
    await act(async () => buttons()[0].click());
    expect(ctx.copy).toHaveBeenCalledWith(
      expect.stringContaining('--gres=gpu:1'),
      t('plan.submit.copied'),
    );
    expect(vi.mocked(ctx.copy).mock.calls[0][0]).not.toContain('#');
    expect(host.querySelector('.plan-best .plan-submit')!.textContent).toContain(
      t('plan.submit.unknown', { flags: '-p, -A' }),
    );
    expect(vi.mocked(ctx.copy).mock.calls[0][0]).toContain('-q long');
    expect(host.querySelector('.plan-copy-format > span')!.textContent).toBe(
      t('plan.submit.format'),
    );
    const header = host.querySelectorAll<HTMLButtonElement>('.plan-copy-format button')[1];
    await act(async () => header.click());
    await act(async () => buttons()[0].click());
    expect(vi.mocked(ctx.copy).mock.calls[1][0]).toContain('#SBATCH');
    expect(localStorage.getItem('computedeck.submitFormat')).toBe('header');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.querySelectorAll('.plan-copy-format button')[1].getAttribute('aria-selected')).toBe(
      'true',
    );
    ctx.demo = true;
    await render();
    expect(buttons().every((button) => !button.disabled)).toBe(true);
    await act(async () => buttons()[0].click());
    expect(ctx.copy).toHaveBeenLastCalledWith(
      expect.stringContaining('#SBATCH'),
      t('plan.submit.copied'),
    );
  },
);

it('works when format storage cannot be read or written', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  await render();
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>('.plan-copy-format button')[1].click(),
  );
  await act(async () => buttons()[0].click());
  expect(ctx.copy).toHaveBeenCalledWith(
    expect.stringContaining('#SBATCH'),
    t('plan.submit.copied'),
  );
});

it.each(['en', 'zh-CN'] as const)(
  'restores from-only links, tags the waiting login, and leaves queue counts unchanged (%s)',
  async (locale) => {
    setLocale(locale);
    const job = ctx.data.jobs.find((job) => job.name === 'llm-sft / ablation')!;
    const request = { gpus: job.gpu_count!, gpuType: job.gpu_type!, hours: null };
    const before = planOptions(ctx.data, request);
    window.history.replaceState(null, '', `/?demo=true#/plan?from=${encodeURIComponent(job.id)}`);
    await render();
    expect(host.querySelector<HTMLInputElement>('.plan-form input')!.value).toBe(
      String(job.gpu_count),
    );
    expect(host.querySelector<HTMLSelectElement>('.plan-form select')!.value).toBe(job.gpu_type);
    expect(host.querySelector('.plan-from')!.textContent).toContain(
      t('plan.forJob', { name: job.name, count: job.gpu_count }),
    );
    const tagged = [...host.querySelectorAll('.plan-table tbody tr')].filter((row) =>
      row.textContent!.includes(t('plan.waitsHere')),
    );
    expect(tagged).toHaveLength(1);
    expect(tagged[0].textContent).toContain('alice');
    expect(planOptions(ctx.data, request)).toEqual(before);
    await act(async () => setRouteParams({ gpus: '8', model: null, hours: '12' }));
    expect(host.querySelector<HTMLSelectElement>('.plan-form select')!.value).toBe('');
    expect(host.querySelector('.plan-from')!.textContent).toContain(
      t('plan.forJob', { name: job.name, count: job.gpu_count }),
    );
    expect(host.querySelector('.plan-from')!.textContent).not.toContain(
      t('plan.forJob', { name: job.name, count: 8 }),
    );
    ctx.data.jobs = ctx.data.jobs.filter((item) => item.id !== job.id);
    await render();
    expect(host.querySelector('.plan-from')!.textContent).toBe(
      t('plan.fromMissing', { id: job.id }),
    );
    expect(host.querySelector<HTMLInputElement>('.plan-form input')!.value).toBe('8');
    await act(async () => host.querySelector<HTMLButtonElement>('.plan-from button')!.click());
    expect(routeParams().get('from')).toBeNull();
    expect(routeParams().get('gpus')).toBe('8');
    expect(window.location.search).toBe('?demo=true');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'keeps Any model after clearing the GPU count of a resolved job link (%s)',
  async (locale) => {
    setLocale(locale);
    const job = ctx.data.jobs.find((item) => item.name === 'llm-sft / lr sweep')!;
    window.history.replaceState(null, '', `#/plan?from=${encodeURIComponent(job.id)}`);
    await render();
    const model = host.querySelector<HTMLSelectElement>('.plan-form select')!;
    const count = host.querySelector<HTMLInputElement>('.plan-form input')!;
    expect(model.value).toBe(job.gpu_type);
    expect(count.value).toBe(String(job.gpu_count));
    await act(async () => {
      model.value = '';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (const [value, expected] of [
      ['', String(job.gpu_count)],
      ['8', '8'],
      ['', '8'],
    ]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          count,
          value,
        );
        count.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(model.value).toBe('');
      expect(routeParams().has('model')).toBe(false);
      expect(routeParams().get('gpus')).toBe(expected);
      expect(count.value).toBe(expected);
    }
    expect(count.value).toBe('8');
    await render();
    expect(model.value).toBe('');
    expect(count.value).toBe('8');
  },
);

it('uses the newest node observation for submit flags on the best card and option rows', async () => {
  const job = ctx.data.jobs[0];
  const source = ctx.data.sources.find((item) => item.id === job.source_id)!;
  const node = ctx.data.nodes.find((item) => item.source_id === source.id)!;
  ctx.data.nodes.push({ ...node, partitions: [], observed_at: '2099-01-01T00:00:00Z' });
  ctx.data.nodes = ctx.data.nodes.filter((item) => item.id === node.id);
  ctx.data.sources = [source];
  ctx.data.jobs = [{ ...job, partition: 'gpu', account: 'research' }];
  ctx.data.recent_failures = [];
  source.qos = source.qos.filter((item) => item.name === job.qos);
  await render();
  expect(host.querySelector('.plan-best .plan-submit')).not.toBeNull();
  expect(buttons().length).toBe(2);
  for (const button of buttons()) {
    await act(async () => button.click());
    const copied = vi.mocked(ctx.copy).mock.calls.at(-1)![0];
    expect(copied).not.toContain('-p ');
    expect(copied).toContain('-A research');
  }
});

it('preset chips fill only the request and job context, clearing run time', async () => {
  ctx.data.jobs[0].submitted_at = '2099-01-01T00:00:00Z';
  await act(async () => setRouteParams({ hours: '24' }));
  await render();
  const presets = host.querySelectorAll<HTMLButtonElement>('.plan-presets button');
  expect(presets.length).toBe(4);
  await act(async () => presets[0].click());
  expect(routeParams().get('gpus')).toBe('4');
  expect(routeParams().get('hours')).toBeNull();
  expect(routeParams().get('from')).toBe(ctx.data.jobs[0].id);
  expect(ctx.copy).not.toHaveBeenCalled();
});

it.each(['en', 'zh-CN'] as const)(
  'links pending and failed drawers, but not a running job (%s)',
  async (locale) => {
    setLocale(locale);
    const pending = ctx.data.jobs.find((job) => job.state === 'PENDING')!;
    for (const job of [pending, ctx.data.recent_failures![0], ctx.data.jobs[0]]) {
      await act(async () => root.render(<JobDetail job={job} ctx={ctx} />));
      const link = host.querySelector<HTMLAnchorElement>('a');
      if (job.state === 'RUNNING') expect(link).toBeNull();
      else {
        expect(link!.textContent).toBe(t('plan.findAnother'));
        const params = new URLSearchParams(link!.hash.split('?')[1]);
        expect(params.get('from')).toBe(job.id);
        expect(params.get('gpus')).toBe(String(job.gpu_count));
      }
    }
  },
);

it('never offers Kubernetes copy actions', async () => {
  ctx.data.sources.forEach((source) => {
    source.driver = 'kubernetes';
  });
  await render();
  expect(buttons()).toHaveLength(0);
  expect(host.querySelector('.plan-copy-format')).toBeNull();
});

it('uses recent failures but not stale live jobs as evidence for copied flags', async () => {
  const source = ctx.data.sources.find((item) => item.id === ctx.data.jobs[0].source_id)!;
  source.capabilities = source.capabilities!.filter((item) => item !== 'jobs');
  ctx.data.recent_failures = [];
  await render();
  const copyRow = () =>
    [...host.querySelectorAll('.plan-table tbody tr')].find(
      (row) =>
        row.querySelector('td')?.textContent?.includes(source.name) &&
        row.querySelector('td')?.textContent?.includes(source.username) &&
        row.querySelector('td .plan-qos')?.textContent === 'normal',
    )!;
  expect(copyRow().textContent).toContain(t('plan.submit.unknown', { flags: '-p, -A' }));
  ctx.data.recent_failures = [{ ...ctx.data.jobs[0], state: 'FAILED', end: null, exit_code: null }];
  await render();
  expect(copyRow().textContent).not.toContain(t('plan.submit.unknown', { flags: '-p, -A' }));
  await act(async () => copyRow().querySelector<HTMLButtonElement>('.plan-submit button')!.click());
  expect(ctx.copy).toHaveBeenCalledWith(
    expect.stringContaining('-A demo-lab'),
    t('plan.submit.copied'),
  );
});

it.each(['en', 'zh-CN'] as const)(
  'shows the job count rather than the form count and uses a name-only banner for unknown or zero (%s)',
  async (locale) => {
    setLocale(locale);
    const job = ctx.data.jobs.find((item) => item.name === 'llm-sft / ablation')!;
    window.history.replaceState(
      null,
      '',
      `#/plan?gpus=4&model=H100&from=${encodeURIComponent(job.id)}`,
    );
    await render();
    expect(host.querySelector('.plan-from')!.textContent).toBe(
      t('plan.forJob', { name: job.name, count: 1 }),
    );
    expect(host.querySelector<HTMLInputElement>('.plan-form input')!.value).toBe('4');
    for (const count of [null, 0]) {
      job.gpu_count = count;
      window.history.replaceState(null, '', `#/plan?from=${encodeURIComponent(job.id)}`);
      await render();
      expect(host.querySelector('.plan-from')!.textContent).toBe(
        t('plan.forJob.nameOnly', { name: job.name }) + t('plan.fromUnknown'),
      );
      expect(host.querySelector('.plan-from')!.textContent).not.toContain(
        t('plan.forJob', { name: job.name, count: 1 }),
      );
      expect(host.querySelector<HTMLInputElement>('.plan-form input')!.value).toBe('1');
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'labels and deduplicates presets by their filled request (%s)',
  async (locale) => {
    setLocale(locale);
    const job = ctx.data.jobs[0];
    ctx.data.jobs = [
      { ...job, id: 'unlisted', gpu_count: 4, gpu_type: 'unlisted' },
      { ...job, id: 'multi', gpu_count: 4, gpu_type: 'A100,H100' },
      { ...job, id: 'unknown', gpu_count: 4, gpu_type: null },
      { ...job, id: 'one', gpu_count: 1, gpu_type: null },
      { ...job, id: 'known', gpu_count: 4 },
    ];
    ctx.data.recent_failures = [];
    await render();
    const presets = host.querySelectorAll<HTMLButtonElement>('.plan-presets button');
    expect(presets).toHaveLength(3);
    expect(presets[0].textContent).toBe(t('plan.preset.noModel', { count: 4, name: job.name }));
    expect(presets[1].textContent).toBe(t('plan.preset.noModel', { count: 1, name: job.name }));
    expect(presets[2].textContent).toBe(
      t('plan.preset', { count: 4, model: job.gpu_type, name: job.name }),
    );
    for (const [index, count, model] of [
      [0, '4', ''],
      [1, '1', ''],
      [2, '4', job.gpu_type!],
    ] as const) {
      await act(async () => presets[index].click());
      expect(host.querySelector<HTMLInputElement>('.plan-form input')!.value).toBe(count);
      expect(host.querySelector<HTMLSelectElement>('.plan-form select')!.value).toBe(model);
    }
  },
);

it('copies current jobs from a twin when the kept login has stale jobs, but excludes stale twins', async () => {
  const job = ctx.data.jobs[0];
  const source = ctx.data.sources.find((item) => item.id === job.source_id)!;
  const twin = { ...source, id: 'twin', capabilities: ['jobs'], qos: [] };
  source.capabilities = source.capabilities!.filter((item) => item !== 'jobs');
  ctx.data.sources.push(twin);
  ctx.data.jobs = [{ ...job, source_id: twin.id, account: 'twin-account' }];
  ctx.data.recent_failures = [];
  const copyRow = () =>
    [...host.querySelectorAll('.plan-table tbody tr')].find(
      (row) =>
        row.querySelector('td')?.textContent?.includes(source.name) &&
        row.querySelector('td')?.textContent?.includes(source.username) &&
        row.querySelector('td .plan-qos')?.textContent === 'normal',
    )!;
  await render();
  expect(
    planOptions(ctx.data, { gpus: 1, gpuType: '', hours: null }).find(
      (option) =>
        option.source.cluster_id === source.cluster_id &&
        option.source.username === source.username &&
        option.qos === 'normal',
    )!.source.id,
  ).toBe(source.id);
  await act(async () => copyRow().querySelector<HTMLButtonElement>('.plan-submit button')!.click());
  expect(ctx.copy).toHaveBeenLastCalledWith(
    expect.stringContaining('-p gpu -A twin-account'),
    t('plan.submit.copied'),
  );
  twin.stale = true;
  await render();
  expect(copyRow().textContent).toContain(t('plan.submit.unknown', { flags: '-p, -A' }));
  await act(async () => copyRow().querySelector<HTMLButtonElement>('.plan-submit button')!.click());
  expect(vi.mocked(ctx.copy).mock.calls.at(-1)![0]).not.toContain('-A twin-account');
});

it.each(['en', 'zh-CN'] as const)(
  'gives explanations full-width rows and names repeated copy controls (%s)',
  async (locale) => {
    setLocale(locale);
    ctx.demo = true;
    await render();
    for (const explanation of host.querySelectorAll('.plan-explanation')) {
      expect(explanation.closest('td')!.colSpan).toBe(6);
      const row = explanation.closest('tr')!;
      expect(row.classList.contains('plan-explanation-row')).toBe(true);
      expect(row.previousElementSibling!.classList.contains('plan-option-row')).toBe(true);
      expect(explanation.querySelector('summary')!.getAttribute('aria-label')).toContain(' · ');
      expect(explanation.querySelectorAll('.plan-factors > div')).toHaveLength(7);
    }
    for (const button of buttons()) expect(button.getAttribute('aria-label')).toContain(' · ');
    const command = host.querySelector<HTMLPreElement>('.machine-command')!;
    expect(command.tabIndex).toBe(0);
    expect(command.getAttribute('aria-label')).toBeTruthy();
    const machineCopy = host.querySelector<HTMLButtonElement>('.machine-actions button')!;
    expect(machineCopy.disabled).toBe(false);
    await act(async () => machineCopy.click());
    expect(ctx.copy).toHaveBeenLastCalledWith(command.textContent);
  },
);
