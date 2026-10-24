// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freeGpuIndexes } from './domain';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { gpuModels, lowUseInstances, machineOptions, machineSamples } from './plan';
import { PlanPage } from './pages/Plan';
import { InstanceDetail } from './pages/Details';
import { UnmeasuredLinks } from './pages/UnmeasuredLinks';
import type { Ctx } from './pages/shared';
import type { GpuRow } from './types';
import { serverDemo } from './test-server';

const request = { gpus: 2, gpuType: '', hours: null };
function fixture() {
  const data = serverDemo();
  data.sources = data.sources.filter((source) => source.driver === 'ssh');
  data.instances = data.instances.filter((item) => item.source_id === data.sources[0].id);
  data.nodes = [];
  data.jobs = [];
  return { data, source: data.sources[0], item: data.instances[0] };
}
function context(data: ReturnType<typeof serverDemo>) {
  return {
    data,
    groups: groupsOf(data),
    demo: false,
    copy: vi.fn(),
    openInstance: vi.fn(),
  } as unknown as Ctx;
}
function drawer(ctx: Ctx) {
  return (
    <InstanceDetail
      item={ctx.data.instances[0]}
      ctx={ctx}
      onProbe={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}
function parse(html: string) {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}
afterEach(() => {
  setLocale('en');
  window.history.replaceState(null, '', '#/plan');
});

describe('SSH machine planning', () => {
  it('uses only explicit free states and copies only those indexes in PCI bus order', () => {
    const { data, item } = fixture();
    expect(freeGpuIndexes(item, '')).toEqual([0]);
    expect(machineOptions(data, request)[0]).toMatchObject({
      free: 1,
      total: 4,
      unknown: 1,
      command: `ssh -t 'lab-server' 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=0; exec "\${SHELL:-sh}" -l'`,
    });
    item.gpus![0].in_use = undefined;
    expect(freeGpuIndexes(item, '')).toEqual([]);
    expect(machineOptions(data, request)[0]).toMatchObject({ free: 0, unknown: 2, command: null });
  });
  it('passes GPU settings and shell expansion to SSH as one remote command', () => {
    const { data, item } = fixture();
    item.gpus = [{ ...item.gpus![0], index: 3 }];
    const command = machineOptions(data, request)[0].command!;
    expect(command).not.toContain('\n');
    // Substitute SSH locally: no connection is made, and the receiving arguments prove quoting.
    const args = execFileSync('sh', ['-c', `ssh() { printf '%s\\n' "$@"; }\n${command}`], {
      encoding: 'utf8',
      env: { ...process.env, SHELL: '/local-shell-must-not-expand' },
    })
      .trim()
      .split('\n');
    expect(args).toEqual([
      '-t',
      'lab-server',
      'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=3; exec "${SHELL:-sh}" -l',
    ]);
  });
  it.each([
    'stale',
    'disabled',
    'error',
    'noCapability',
    'old',
    'missing',
    'invalid',
    'cloud',
    'manual',
  ])('excludes %s samples', (kind) => {
    const { data, source, item } = fixture();
    if (kind === 'stale') source.stale = true;
    if (kind === 'disabled') source.enabled = false;
    if (kind === 'error') source.status = 'error';
    if (kind === 'noCapability') source.capabilities = [];
    if (kind === 'old') item.gpus_observed_at = new Date(Date.now() - 1200001).toISOString();
    if (kind === 'missing') item.gpus_observed_at = null;
    if (kind === 'invalid') item.gpus_observed_at = 'invalid';
    if (kind === 'cloud') source.driver = 'runpod';
    if (kind === 'manual') item.source_id = 'manual';
    // A fresh aggregate probe cannot renew old per-GPU data.
    item.observed_at = new Date().toISOString();
    expect(machineOptions(data, request)).toEqual([]);
  });
  it('counts only otherwise eligible machines with missing or old GPU samples', () => {
    const { data, item, source } = fixture();
    const now = Date.now();
    expect(machineSamples(data, now).staleCount).toBe(0);
    for (const timestamp of [null, 'invalid', new Date(now - 1200001).toISOString()]) {
      item.gpus_observed_at = timestamp;
      expect(machineSamples(data, now)).toEqual({ current: [], staleCount: 1 });
    }
    item.gpus_observed_at = new Date(now).toISOString();
    for (const gpus of [[], null]) {
      item.gpus = gpus;
      expect(machineSamples(data, now)).toEqual({ current: [], staleCount: 0 });
    }
    item.gpus_observed_at = null;
    item.state = 'stopped';
    expect(machineSamples(data, now).staleCount).toBe(0);
    item.state = 'running';
    source.enabled = false;
    expect(machineSamples(data, now).staleCount).toBe(0);
    source.enabled = true;
    source.stale = true;
    expect(machineSamples(data, now).staleCount).toBe(0);
    source.stale = false;
    source.driver = 'runpod';
    expect(machineSamples(data, now).staleCount).toBe(0);
  });
  it('keeps samples 60 seconds ahead of the browser clock current', () => {
    const { data, item } = fixture();
    const now = Date.now();
    item.gpus_observed_at = new Date(now + 60000).toISOString();
    expect(machineOptions(data, request, now)).toHaveLength(1);
    expect(machineOptions(data, request, now)[0].free).toBe(1);
  });
  it.each(['missing', 'unknown', 'stopped'])(
    'excludes a fresh %s instance and its models',
    (state) => {
      const { data, item } = fixture();
      expect(machineOptions(data, request)).toHaveLength(1);
      item.state = state;
      item.gpus_observed_at = new Date().toISOString();
      const options = machineOptions(data, request);
      expect(options).toEqual([]);
      expect(
        gpuModels(
          data.nodes,
          options.map((option) => option.instance),
        ),
      ).toEqual([]);
      const view = parse(renderToStaticMarkup(<PlanPage ctx={context(data)} />));
      expect(view.querySelector('.machine-options')).toBeNull();
      expect(
        [...view.querySelectorAll('select option')].map((option) => option.textContent),
      ).not.toContain('NVIDIA L4');
    },
  );
  it('exports only the requested free indexes in numeric index order', () => {
    const { data, item } = fixture();
    const free = item.gpus![0];
    item.gpus = [12, 3, 2].map((index) => ({ ...free, index }));
    for (const [gpus, indexes] of [
      [1, '2'],
      [2, '2,3'],
      [4, '2,3,12'],
    ] as const) {
      expect(machineOptions(data, { ...request, gpus })[0]).toMatchObject({
        free: 3,
        command: `ssh -t 'lab-server' 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=${indexes}; exec "\${SHELL:-sh}" -l'`,
      });
    }
  });
  it('honors exactly two source intervals and requires per-GPU rows', () => {
    const { data, source, item } = fixture();
    const now = Date.now();
    source.interval_minutes = 1;
    item.gpus_observed_at = new Date(now - 120000).toISOString();
    expect(machineOptions(data, request, now)).toHaveLength(1);
    expect(machineOptions(data, request, now + 1)).toEqual([]);
    item.gpus = [];
    expect(machineOptions(data, request, now)).toEqual([]);
  });
  it('filters exact models case-insensitively and includes intact machine names in the selector', () => {
    const { data, item } = fixture();
    item.gpus![0].name = 'NVIDIA A100, PCIe';
    expect(gpuModels([], [item])).toEqual(['NVIDIA A100, PCIe', 'NVIDIA L4']);
    expect(freeGpuIndexes(item, 'nvidia a100, pcie')).toEqual([0]);
    expect(machineOptions(data, { ...request, gpuType: 'nvidia a100, pcie' })[0]).toMatchObject({
      free: 1,
      total: 1,
      unknown: 0,
    });
    expect(machineOptions(data, { ...request, gpuType: 'H100' })[0]).toMatchObject({
      free: 0,
      total: 0,
      command: null,
    });
    item.gpus![0].name = null;
    expect(machineOptions(data, { ...request, gpuType: 'H100' })[0]).toMatchObject({
      free: 0,
      unknown: 1,
    });
  });
  it('uses the NVIDIA process capability, not model spelling, to offer CUDA', () => {
    const { data, item, source } = fixture();
    item.gpus![0].name = 'Tesla V100-SXM2-32GB';
    expect(machineOptions(data, request)[0].command).toContain('CUDA_VISIBLE_DEVICES=0');
    // AMD has no process capability and cannot supply a confirmed free row.
    source.capabilities = ['instances'];
    item.gpus = [{ ...item.gpus![0], name: 'AMD Instinct MI210', processes: null, in_use: null }];
    expect(machineOptions(data, request)[0]).toMatchObject({ free: 0, unknown: 1, command: null });
  });
  it('sorts by known free count and leaves host-visible instances out of cloud idle hints', () => {
    const { data, item } = fixture();
    item.gpu_utilization = 0;
    data.instances.push({
      ...item,
      id: 'other',
      name: 'other',
      gpus: item.gpus!.map((gpu) => ({ ...gpu, in_use: false })),
    });
    expect(machineOptions(data, request).map((option) => option.free)).toEqual([4, 1]);
    expect(lowUseInstances(data.instances)).toEqual([]);
    expect(lowUseInstances([{ ...item, metrics_scope: undefined }])).toEqual([]);
  });
});

describe.each(['en', 'zh-CN'] as const)('machine UI in %s', (locale) => {
  it('hides nonmatching machines with one count note and preserves unknown models', async () => {
    setLocale(locale);
    const { data, item } = fixture();
    window.history.replaceState(null, '', '#/plan?model=H100');
    const view = document.createElement('div');
    const root = createRoot(view);
    try {
      await act(async () => root.render(<PlanPage ctx={context(data)} />));
      expect(view.querySelector('.machine-options')).toBeNull();
      expect(view.textContent).toContain(
        locale === 'en'
          ? '1 machine has no matching GPU; hidden.'
          : '1 台机器没有匹配的 GPU，已隐藏。',
      );
      expect(view.textContent).not.toContain(t('plan.machinesEmpty'));
      expect(
        [...view.querySelectorAll('select option')].map((option) => option.textContent),
      ).toContain('NVIDIA L4');
      data.instances.push({ ...item, id: 'other', name: 'other' });
      await act(async () => root.render(<PlanPage ctx={context(data)} />));
      expect(view.textContent).toContain(
        locale === 'en'
          ? '2 machines have no matching GPU; hidden.'
          : '2 台机器没有匹配的 GPU，已隐藏。',
      );
      item.gpus = [{ ...item.gpus![0], name: null }];
      await act(async () => root.render(<PlanPage ctx={context(data)} />));
      expect(view.querySelectorAll('.machine-options li')).toHaveLength(1);
      expect(view.textContent).toContain(t('plan.machineUnknown', { count: 1 }));
      expect(view.querySelector('.machine-command')).toBeNull();
      window.history.replaceState(null, '', '#/plan');
      await act(async () => root.render(<PlanPage ctx={context(data)} />));
      expect(view.querySelectorAll('.machine-options li')).toHaveLength(2);
      expect(view.textContent).not.toContain(t('plan.machinesNoMatch', { count: 1 }));
    } finally {
      await act(async () => root.unmount());
    }
  });
  it('counts hidden old and missing samples separately from model mismatches', async () => {
    setLocale(locale);
    const { data, item } = fixture();
    data.instances.push(
      { ...item, id: 'old', gpus_observed_at: new Date(Date.now() - 1200001).toISOString() },
      { ...item, id: 'missing', gpus: null, gpus_observed_at: null },
      { ...item, id: 'stopped', state: 'stopped', gpus: null },
    );
    window.history.replaceState(null, '', '#/plan?model=H100');
    const view = document.createElement('div');
    const root = createRoot(view);
    try {
      await act(async () => root.render(<PlanPage ctx={context(data)} />));
      expect(view.textContent).toContain(t('plan.machinesNoMatch', { count: 1 }));
      expect(view.textContent).toContain(
        locale === 'en'
          ? '2 machines hidden: GPU sample missing or too old.'
          : '2 台机器已隐藏：GPU 采样缺失或过旧。',
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
  it('excludes current CPU-only machines without a stale-sample note', () => {
    setLocale(locale);
    const { data, item } = fixture();
    item.gpus_observed_at = new Date().toISOString();
    for (const gpus of [[], null]) {
      item.gpus = gpus;
      const view = parse(renderToStaticMarkup(<PlanPage ctx={context(data)} />));
      expect(view.querySelector('.machine-options')).toBeNull();
      expect(view.textContent).not.toContain(t('plan.machinesStale', { count: 1 }));
    }
  });
  it('uses dashes for unknown memory and orders equal-memory owners by process count', () => {
    setLocale(locale);
    const { data, item } = fixture();
    item.gpus = [
      {
        ...item.gpus![3],
        processes: [
          { pid: 1, user: 'alice', memory_mb: 1024 },
          { pid: 2, user: 'bob', memory_mb: 512 },
          { pid: 3, user: 'bob', memory_mb: 512 },
        ],
      },
    ];
    let view = parse(renderToStaticMarkup(drawer(context(data)))).querySelector('.gpu-details')!;
    expect(view.textContent).toContain(t('gpu.memory', { used: '—', total: '24 GiB' }));
    expect(view.textContent!.indexOf('bob')).toBeLessThan(view.textContent!.indexOf('alice'));
    item.gpus[0].processes = [{ pid: 1, user: null, memory_mb: null }];
    view = parse(renderToStaticMarkup(drawer(context(data)))).querySelector('.gpu-details')!;
    expect(view.textContent).toContain(
      t('gpu.owner', { user: t('gpu.unknownUser'), count: 1, memory: '—' }),
    );
  });
  it('labels legacy GPU samples without a timestamp explicitly', () => {
    setLocale(locale);
    const { data, item } = fixture();
    delete item.gpus_observed_at;
    item.gpus!.forEach((gpu) => delete gpu.in_use);
    const view = parse(renderToStaticMarkup(drawer(context(data)))).querySelector('.gpu-details')!;
    expect(view.querySelector('.panel-note')?.textContent).toBe(
      locale === 'en' ? 'Sample time unknown' : '采样时间未知',
    );
    expect([...view.querySelectorAll('.tag')].map((tag) => tag.textContent)).toEqual(
      item.gpus!.map(() => t('status.unknown')),
    );
  });
  it('uses singular wording for the example Lab server unknown GPU', () => {
    setLocale(locale);
    const data = serverDemo();
    const view = parse(renderToStaticMarkup(<PlanPage ctx={context(data)} />));
    const machines = view.querySelector('.machine-options')!;
    expect(machines.textContent).toContain('Lab server');
    expect(machines.textContent).toContain(
      locale === 'en'
        ? '1 GPU has unknown availability or model; not counted as free.'
        : '1 张 GPU 的可用状态或型号未知，不计为空闲。',
    );
    expect(machines.textContent).not.toContain('1 GPUs');
  });
  it('explains unknown memory without falsely reporting unreadable processes', () => {
    setLocale(locale);
    const { data, item } = fixture();
    expect(item.gpus![3]).toMatchObject({ processes: [], memory_used_mb: null, in_use: null });
    const missing = data.summary.unmeasured.filter((row) => row.subject.id === item.id);
    expect(missing).toHaveLength(1);
    expect(missing[0].reason.code).toBe('summary_gpu_processes_unavailable');
    const view = parse(
      renderToStaticMarkup(<UnmeasuredLinks items={missing} ctx={context(data)} />),
    );
    expect(view.textContent).toContain(
      locale === 'en'
        ? 'GPU use not readable on every GPU (processes or memory)'
        : '部分 GPU 的使用情况无法读取（进程或显存）',
    );
    expect(view.textContent).not.toContain(
      locale === 'en' ? 'GPU processes not available' : '无法读取 GPU 进程',
    );
  });
  it('labels measured use without implying visible processes', () => {
    setLocale(locale);
    const { data, item } = fixture();
    const label = locale === 'en' ? 'GPUs in use' : '使用中的 GPU';
    const oldLabel = locale === 'en' ? 'GPUs with processes' : '有进程的 GPU';
    // A GPU can be busy even with an empty visible process list.
    item.gpus = [item.gpus![2]];
    expect(item.gpus[0]).toMatchObject({ in_use: true, processes: [] });
    for (const count of [1, null]) {
      item.gpu_allocated = count;
      const html = renderToStaticMarkup(drawer(context(data)));
      expect(html).toContain(`${label}</dt><dd>${count ?? '—'}`);
      expect(html).not.toContain(oldLabel);
    }
    item.metrics_scope = undefined;
    const html = renderToStaticMarkup(drawer(context(data)));
    expect(html).not.toContain(`${label}</dt>`);
  });
  it('shows all four GPU states and the GPU sample time without exposing PIDs', () => {
    setLocale(locale);
    const { data, item } = fixture();
    item.observed_at = new Date().toISOString();
    item.gpus_observed_at = new Date(Date.now() - 180000).toISOString();
    const view = parse(renderToStaticMarkup(drawer(context(data)))).querySelector('.gpu-details')!;
    for (const key of ['gpu.free', 'gpu.busy', 'gpu.busyHidden', 'status.unknown'] as const)
      expect(view.textContent).toContain(t(key));
    expect(view.textContent).toContain(
      t('gpu.owner', { user: 'alice', count: 1, memory: '15.6 GiB' }),
    );
    expect([...view.querySelectorAll('.sub')].every((line) => line.textContent?.trim())).toBe(true);
    expect(
      [...view.querySelectorAll('li')].map((row) => row.querySelectorAll('.sub').length),
    ).toEqual([1, 2, 1, 1]);
    expect(view.textContent).not.toContain('4242');
    expect(view.textContent).toContain(t('time.minutesAgo', { count: 3 }));
  });
  it('bounds owners, reports omitted processes, and preserves unknown memory and users', () => {
    setLocale(locale);
    const { data, item } = fixture();
    const gpu: GpuRow = {
      ...item.gpus![1],
      processes: [
        { pid: 4242, user: null, memory_mb: null },
        { pid: 4243, user: 'alice', memory_mb: 1024 },
        { pid: 4244, user: 'alice', memory_mb: 2048 },
        { pid: 4245, user: 'bob', memory_mb: 1024 },
      ],
      processes_omitted: 4,
    };
    item.gpus = [gpu];
    const view = parse(renderToStaticMarkup(drawer(context(data)))).querySelector('.gpu-details')!;
    expect(view.textContent).toContain(t('gpu.owner', { user: 'bob', count: 1, memory: '1 GiB' }));
    expect(view.textContent).toContain(
      t('gpu.owner', { user: 'alice', count: 2, memory: '3 GiB' }),
    );
    expect(view.textContent).toContain(locale === 'en' ? '+1 owner' : '另有 1 位用户');
    expect(view.textContent).not.toContain('+1 owners');
    expect(view.textContent).toContain(t('gpu.omitted', { count: 4 }));
    expect(view.textContent).not.toContain(t('gpu.unknownUser'));
    expect(view.textContent!.indexOf('alice')).toBeLessThan(view.textContent!.indexOf('bob'));
    gpu.processes_omitted = 1;
    const singular = parse(renderToStaticMarkup(drawer(context(data)))).textContent;
    expect(singular).toContain(
      locale === 'en'
        ? '1 more process not shown; owner totals cover shown processes only'
        : '另有 1 个进程未显示；用户合计仅包含已显示的进程',
    );
    expect(singular).not.toContain('1 more processes');
    item.gpus = null;
    expect(renderToStaticMarkup(drawer(context(data)))).not.toContain('gpu-details');
  });
  it('shows lower bounds, machine-only navigation and model choices, with stale exclusion explained', () => {
    setLocale(locale);
    const { data, item } = fixture();
    window.history.replaceState(null, '', '#/plan?gpus=2');
    const ctx = context(data);
    const view = parse(renderToStaticMarkup(<PlanPage ctx={ctx} />));
    expect(view.textContent).toContain(t('plan.machinesNote'));
    expect(view.textContent).toContain(t('plan.machineFree', { free: '≥ 1', total: 4 }));
    expect(view.textContent).not.toContain(t('plan.empty'));
    expect(
      [...view.querySelectorAll('select option')].map((option) => option.textContent),
    ).toContain('NVIDIA L4');
    item.gpus_observed_at = null;
    const stale = renderToStaticMarkup(<PlanPage ctx={ctx} />);
    expect(stale).toContain(t('plan.machinesEmpty'));
    expect(stale).toContain(t('plan.machineFreshness'));
    expect(stale).toContain(t('plan.machinesStale', { count: 1 }));
  });
  it.each([
    { requested: 1, indexes: [3, 1, 2], selected: '1', muted: false },
    { requested: 2, indexes: [0], selected: '0', muted: true },
  ])(
    'copies the requested setup with $requested requested and $indexes free',
    async ({ requested, indexes, selected, muted }) => {
      setLocale(locale);
      const { data, item } = fixture();
      item.gpus = indexes.map((index) => ({ ...item.gpus![0], index }));
      const ctx = context(data);
      window.history.replaceState(null, '', `#/plan?gpus=${requested}`);
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(async () => root.render(<PlanPage ctx={ctx} />));
        expect(container.querySelector('.machine-options li')?.classList.contains('muted')).toBe(
          muted,
        );
        const command = `ssh -t 'lab-server' 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=${selected}; exec "\${SHELL:-sh}" -l'`;
        expect(container.querySelector('.machine-command')!.textContent).toBe(command);
        expect(container.textContent).toContain(
          locale === 'en'
            ? 'Copy only: paste to open an SSH shell with these GPU settings, then run your command there. Copying runs nothing and reserves no GPU.'
            : '仅复制：粘贴后会打开带有这些 GPU 设置的 SSH shell，然后在其中运行你的命令。复制操作不会执行命令或预留 GPU。',
        );
        const [copy, open] =
          container.querySelectorAll<HTMLButtonElement>('.machine-actions button');
        expect(copy.textContent).toBe(
          muted
            ? locale === 'en'
              ? 'Copy setup for 1 of 2 GPUs'
              : '复制 1 张 GPU 的设置（请求 2 张）'
            : t('plan.machineCopy'),
        );
        await act(async () => copy.click());
        expect(ctx.copy).toHaveBeenCalledWith(command);
        await act(async () => open.click());
        expect(ctx.openInstance).toHaveBeenCalledWith(data.instances[0]);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});
