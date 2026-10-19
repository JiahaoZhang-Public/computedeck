import { serverNodeHealth } from './test-server';
import { describe, expect, it } from 'vitest';
import { gpuModels, idleInstances, planOptions, wallHours } from './plan';
import type { ComputeNode, Instance, Job, QosLimit, Source } from './types';

const source = (extra: Partial<Source> = {}): Source => ({
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
  last_success: '2026-01-01T00:00:00Z',
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: ['jobs', 'nodes', 'qos_limits', 'qos_access'],
  qos: [
    {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=8', MaxWallPJ: '1440' },
      access: 'verified' as const,
      origin: 'test',
    },
    // No MaxTRESPU at all: the GPU limit is unknown (gres/gpu=N would mean no limit).
    {
      name: 'long',
      limits: { MaxWallPJ: '7-00:00:00' },
      access: 'verified' as const,
      origin: 'test',
    },
  ],
  ...extra,
});
const node = (name: string, extra: Partial<ComputeNode> = {}): ComputeNode => ({
  id: `cluster-a:${name}`,
  source_id: 'cluster-a-alice',
  cluster_id: 'cluster-a',
  name,
  state: 'mixed',
  health: serverNodeHealth(extra.state ?? 'mixed'),
  gpu_count: 8,
  gpu_allocated: 4,
  gpu_type: 'a100',
  cpu_count: 64,
  cpu_allocated: 8,
  partitions: ['gpu'],
  observed_at: '2026-01-01T00:00:00Z',
  ...extra,
});
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id: `cluster-a:${id}`,
  source_id: 'cluster-a-alice',
  cluster_id: 'cluster-a',
  name: 'train',
  user: 'alice',
  account: 'lab',
  partition: 'gpu',
  qos: 'normal',
  state: 'RUNNING',
  gpu_count: 4,
  gpu_type: 'a100',
  cpu_count: 8,
  node: 'g1',
  elapsed: '1:00',
  reason: null,
  gpu_utilization: null,
  cpu_utilization: null,
  memory_utilization: null,
  observed_at: null,
  ...extra,
});

describe('wall time', () => {
  it('reads minutes and Slurm durations', () => {
    expect(wallHours('1440')).toBe(24);
    expect(wallHours('7-00:00:00')).toBe(168);
    expect(wallHours('02:30:00')).toBe(2.5);
    expect(wallHours('UNLIMITED')).toBeNull();
    expect(wallHours(null)).toBeNull();
  });
});

describe('where to run', () => {
  const data = {
    sources: [source()],
    nodes: [node('g1'), node('g2', { gpu_allocated: 8 }), node('g3', { state: 'drain' })],
    jobs: [job('1'), job('2', { state: 'PENDING', reason: 'QOSMaxGRESPerUser' })],
  };

  it('requires current permission evidence even when jobs and limits are fresh', () => {
    const [option] = planOptions(
      {
        sources: [source({ capabilities: ['jobs', 'nodes', 'qos_limits'] })],
        jobs: [],
        nodes: [node('g1', { gpu_allocated: 0 })],
      },
      { gpus: 4, gpuType: '', hours: null },
    );
    expect(option).toMatchObject({ access: 'unknown', headroom: 8, verdict: 'possible' });
  });

  it('does not reuse old limits or usage when only permission verification succeeds', () => {
    const [option] = planOptions(
      {
        sources: [source({ capabilities: ['jobs', 'nodes', 'qos_access'] })],
        jobs: [],
        nodes: [node('g1', { gpu_allocated: 0 })],
      },
      { gpus: 4, gpuType: '', hours: 48 },
    );
    expect(option).toMatchObject({
      access: 'verified',
      limit: null,
      headroom: null,
      maxWallHours: null,
      rules: [],
      verdict: 'possible',
    });
  });

  it('compares free GPUs, QoS headroom and queued jobs per QoS', () => {
    const [normal, long] = ['normal', 'long'].map((name) =>
      planOptions(data, { gpus: 4, gpuType: '', hours: null }).find((o) => o.qos === name)!,
    );
    // g3 is drained, so only g1's 4 free GPUs count.
    expect(normal).toMatchObject({ freeGpus: 4, largestNodeFree: 4, limit: 8, used: 4 });
    expect(normal.headroom).toBe(4);
    expect(normal.queued).toBe(1);
    expect(normal.reasons).toEqual(['QOSMaxGRESPerUser']);
    expect(normal.verdict).toBe('likely');
    // No GPU limit is known for "long", and no jobs run in it.
    expect(long).toMatchObject({ limit: null, headroom: null, used: 0, verdict: 'possible' });
  });

  it('explains why a request does not fit', () => {
    const rows = (gpus: number, hours: number | null = null) =>
      planOptions(data, { gpus, gpuType: '', hours });
    expect(rows(6).find((o) => o.qos === 'normal')!.verdict).toBe('limit');
    expect(rows(6).find((o) => o.qos === 'long')!.verdict).toBe('busy');
    expect(rows(2, 48).find((o) => o.qos === 'normal')!.verdict).toBe('wall');
    expect(rows(2, 48).find((o) => o.qos === 'long')!.verdict).toBe('possible');
  });

  it('prefers more room in the QoS when free GPUs are equal', () => {
    const roomy = {
      ...data,
      sources: [
        source({
          qos: [
            {
              name: 'small',
              limits: { MaxTRESPU: 'gres/gpu=2' },
              access: 'verified' as const,
              origin: 'test',
            },
            {
              name: 'large',
              limits: { MaxTRESPU: 'gres/gpu=16' },
              access: 'verified' as const,
              origin: 'test',
            },
          ],
        }),
      ],
      jobs: [],
    };
    const options = planOptions(roomy, { gpus: 1, gpuType: '', hours: null });
    expect(options.map((o) => o.qos)).toEqual(['large', 'small']);
  });

  it('ranks options that can start before those that cannot', () => {
    const verdicts = planOptions(data, { gpus: 4, gpuType: '', hours: null }).map((o) => o.verdict);
    expect(verdicts).toEqual(['likely', 'possible']);
  });

  it('filters by GPU model and treats unknown models as not matching', () => {
    const mixed = {
      ...data,
      nodes: [
        node('g1'),
        node('h1', { gpu_type: 'h100', gpu_allocated: 0 }),
        node('x', { gpu_type: null }),
      ],
    };
    const h100 = planOptions(mixed, { gpus: 8, gpuType: 'H100', hours: null });
    expect(h100[0]).toMatchObject({ freeGpus: 8, matchingNodes: 1 });
    expect(gpuModels(mixed.nodes)).toEqual(['a100', 'h100']);
  });

  it('counts a starting job against the QoS limit', () => {
    const starting = {
      ...data,
      jobs: [job('1'), job('3', { state: 'CONFIGURING', gpu_count: 2 })],
    };
    const normal = planOptions(starting, { gpus: 4, gpuType: '', hours: null }).find(
      (o) => o.qos === 'normal',
    );
    expect(normal).toMatchObject({ used: 6, headroom: 2, verdict: 'limit' });
  });

  it('uses the usage a quota reports over a sum of jobs', () => {
    const quota = {
      ...data,
      sources: [
        source({
          qos: [
            {
              name: 'gpu-quota',
              limits: { MaxTRESPU: 'gres/gpu=8', UsedTRESPU: 'gres/gpu=6' },
              access: 'verified' as const,
              origin: 'test',
            },
          ],
        }),
      ],
    };
    const [option] = planOptions(quota, { gpus: 4, gpuType: '', hours: null });
    expect(option).toMatchObject({ limit: 8, used: 6, headroom: 2, verdict: 'limit' });
  });

  it('treats a QoS without a GPU limit as unlimited, not unknown', () => {
    const open = {
      ...data,
      sources: [
        source({
          qos: [
            {
              name: 'normal',
              limits: { MaxTRESPU: 'cpu=N,gres/gpu=N' },
              access: 'verified' as const,
              origin: 'test',
            },
          ],
        }),
      ],
    };
    const [option] = planOptions(open, { gpus: 4, gpuType: '', hours: null });
    expect(option.limit).toBe(Infinity);
    expect(option.verdict).toBe('likely');
  });

  it('keeps unknown allocation unknown instead of counting it as free', () => {
    const unknown = { ...data, nodes: [node('g1', { gpu_allocated: null })] };
    const [option] = planOptions(unknown, { gpus: 1, gpuType: '', hours: null });
    expect(option.freeGpus).toBeNull();
    expect(option.largestNodeFree).toBeNull();
  });

  it('skips disabled logins and cloud sources', () => {
    const sources = [
      source({ enabled: false }),
      source({ id: 'pods', kind: 'cloud', driver: 'runpod' }),
    ];
    expect(planOptions({ ...data, sources }, { gpus: 1, gpuType: '', hours: null })).toEqual([]);
  });
});

describe('idle cloud GPUs', () => {
  it('lists running instances with low measured utilization only', () => {
    const base = { gpu_count: 1, gpu_utilization: 3, state: 'running' } as Instance;
    const rows = idleInstances([
      { ...base, id: 'a' },
      { ...base, id: 'b', gpu_utilization: null },
      { ...base, id: 'c', gpu_utilization: 60 },
      { ...base, id: 'd', state: 'stopped' },
      // A machine added by hand is not a cloud GPU being billed.
      { ...base, id: 'e', manual: true },
      { ...base, id: 'reported', state: 'reported_running' },
      { ...base, id: 'starting', state: 'desired_running' },
      { ...base, id: 'stopping', state: 'desired_stopped' },
      { ...base, id: 'unknown', state: 'unknown' },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'reported']);
  });
});

describe('adversarial GPU planning', () => {
  const request = { gpus: 8, gpuType: 'a10', hours: null };
  it('does not match A100 when A10 is selected', () => {
    const options = planOptions(
      {
        sources: [source()],
        jobs: [],
        nodes: [
          node('a10', { gpu_type: 'a10', gpu_count: 2, gpu_allocated: 0 }),
          node('a100', { gpu_type: 'a100', gpu_allocated: 0 }),
        ],
      },
      request,
    );
    expect(options[0]).toMatchObject({
      freeGpus: 2,
      largestNodeFree: 2,
      matchingNodes: 1,
      verdict: 'busy',
    });
  });
  it('does not assign a mixed node total to one GPU model', () => {
    const options = planOptions(
      {
        sources: [source()],
        jobs: [],
        nodes: [node('mixed', { gpu_type: 'a100,v100', gpu_count: 6, gpu_allocated: 0 })],
      },
      { ...request, gpuType: 'v100' },
    );
    expect(options[0]).toMatchObject({ freeGpus: null, largestNodeFree: null });
    expect(gpuModels([node('mixed', { gpu_type: 'a100,v100' })])).toEqual(['a100', 'v100']);
  });
  it.each(['gres/gpu=64,gres/gpu:mi210=8', 'gres/gpu:mi210=8,gres/gpu=64'])(
    'enforces the typed limit regardless of order: %s',
    (MaxTRESPU) => {
      const [option] = planOptions(
        {
          sources: [
            source({
              qos: [
                {
                  name: 'normal',
                  limits: { MaxTRESPU },
                  access: 'verified' as const,
                  origin: 'test',
                },
              ],
            }),
          ],
          jobs: [],
          nodes: [node('mi', { gpu_type: 'mi210', gpu_count: 64, gpu_allocated: 0 })],
        },
        { ...request, gpus: 16, gpuType: 'mi210' },
      );
      expect(option).toMatchObject({ limit: 8, used: 0, headroom: 8, verdict: 'limit' });
    },
  );
  it('counts other GPU models against the total limit but not the typed limit', () => {
    const [option] = planOptions(
      {
        sources: [
          source({
            qos: [
              {
                name: 'normal',
                limits: { MaxTRESPU: 'gres/gpu=64,gres/gpu:mi210=8' },
                access: 'verified' as const,
                origin: 'test',
              },
            ],
          }),
        ],
        jobs: [
          job('a', { gpu_count: 56, gpu_type: 'a100' }),
          job('m', { gpu_count: 2, gpu_type: 'mi210' }),
        ],
        nodes: [node('mi', { gpu_type: 'mi210', gpu_count: 64, gpu_allocated: 0 })],
      },
      { ...request, gpus: 4, gpuType: 'mi210' },
    );
    expect(option).toMatchObject({ headroom: 6, verdict: 'likely' });
  });
  it('keeps typed headroom unknown when the running GPU model is unknown', () => {
    const [option] = planOptions(
      {
        sources: [
          source({
            qos: [
              {
                name: 'normal',
                limits: { MaxTRESPU: 'gres/gpu=64,gres/gpu:mi210=8' },
                access: 'verified' as const,
                origin: 'test',
              },
            ],
          }),
        ],
        jobs: [job('a', { gpu_type: null })],
        nodes: [node('mi', { gpu_type: 'mi210', gpu_allocated: 0 })],
      },
      { ...request, gpus: 4, gpuType: 'mi210' },
    );
    expect(option).toMatchObject({ headroom: null, verdict: 'possible' });
  });
  it('does not treat failed collection snapshots as current free capacity', () => {
    const [option] = planOptions(
      {
        sources: [source({ status: 'error' })],
        jobs: [],
        nodes: [node('free', { gpu_allocated: 0 })],
      },
      { ...request, gpuType: '' },
    );
    expect(option).toMatchObject({
      freeGpus: null,
      used: null,
      headroom: null,
      verdict: 'unknown',
    });
  });
  it('excludes reserved capacity but allows an idle powered-down cloud node', () => {
    const [option] = planOptions(
      {
        sources: [source()],
        jobs: [],
        nodes: [
          node('reserved', { state: 'idle+reserved', gpu_allocated: 0 }),
          node('cloud', { state: 'idle+cloud+powered_down', gpu_allocated: 0 }),
        ],
      },
      { ...request, gpuType: '' },
    );
    expect(option).toMatchObject({ freeGpus: 8, matchingNodes: 1 });
  });
  it('does not count the GPUs of a Slurm INVAL node as free', () => {
    const [option] = planOptions(
      {
        sources: [source()],
        jobs: [],
        nodes: [
          node('bad', { state: 'inval', gpu_allocated: 0 }),
          node('saving', { state: 'idle+power_down', gpu_allocated: 0 }),
        ],
      },
      { ...request, gpuType: '' },
    );
    expect(option).toMatchObject({ freeGpus: 8, matchingNodes: 1 });
  });
});

it('does not promise a typed QoS can accept an unspecified GPU model', () => {
  const [option] = planOptions(
    {
      sources: [
        source({
          qos: [
            {
              name: 'normal',
              limits: { MaxTRESPU: 'gres/gpu=64,gres/gpu:a100=2' },
              access: 'verified' as const,
              origin: 'test',
            },
          ],
        }),
      ],
      jobs: [],
      nodes: [node('a', { gpu_allocated: 0 })],
    },
    { gpus: 4, gpuType: '', hours: null },
  );
  expect(option).toMatchObject({ headroom: null, verdict: 'possible' });
});

describe('QoS rules besides the per-user GPU limit', () => {
  const withQos = (qos: QosLimit, extra: Partial<Source> = {}) => source({ qos: [qos], ...extra });
  const free = [node('g1', { gpu_allocated: 0 }), node('g2', { gpu_allocated: 0 })];
  const ask = (gpus: number, gpuType = '') => ({ gpus, gpuType, hours: null });
  const optionFor = (qos: QosLimit, jobs: Job[], request = ask(1), extra: Partial<Source> = {}) =>
    planOptions({ sources: [withQos(qos, extra)], nodes: free, jobs }, request)[0];

  it('is over the limit when your running jobs already reach MaxJobsPU', () => {
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=8', MaxJobsPU: '2' },
      access: 'verified' as const,
      origin: 't',
    };
    // Two running 1-GPU jobs use up the job limit while the GPU limit has room.
    const running = [job('1', { gpu_count: 1 }), job('2', { gpu_count: 1 })];
    const option = optionFor(qos, running);
    expect(option).toMatchObject({ headroom: 6, verdict: 'limit' });
    expect(option.rule).toEqual({ kind: 'jobs', limit: 2, used: 2, effect: 'limit' });
    // A queued job does not count against MaxJobsPU.
    expect(optionFor(qos, [running[0], job('3', { state: 'PENDING' })]).verdict).toBe('likely');
  });

  it("believes the scheduler's job count over the jobs this login lists", () => {
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=8', MaxJobsPU: '4' },
      usage: { MaxJobsPU: '4', MaxTRESPU: 'cpu=16,gres/gpu=2' },
      access: 'verified' as const,
      origin: 't',
    };
    expect(optionFor(qos, [])).toMatchObject({ used: 2, verdict: 'limit' });
    // Usage from a collection that is no longer current is not believed.
    expect(optionFor(qos, [], ask(1), { capabilities: ['jobs', 'nodes'] })).toMatchObject({
      access: 'unknown',
      limit: null,
      headroom: null,
      verdict: 'possible',
    });
  });

  it('is over the limit when running and queued jobs reach MaxSubmitJobsPU', () => {
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=8', MaxSubmitJobsPU: '2' },
      access: 'verified' as const,
      origin: 't',
    };
    const option = optionFor(qos, [job('1', { gpu_count: 1 }), job('2', { state: 'PENDING' })]);
    expect(option.rule).toMatchObject({ kind: 'submit', limit: 2, used: 2 });
    expect(option.verdict).toBe('limit');
  });

  it('is over the limit when one job asks for more GPUs than MaxTRESPJ allows', () => {
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=16', MaxTRESPJ: 'gres/gpu=4' },
      access: 'verified' as const,
      origin: 't',
    };
    expect(optionFor(qos, [], ask(4)).verdict).toBe('likely');
    expect(optionFor(qos, [], ask(8))).toMatchObject({
      verdict: 'limit',
      rule: { kind: 'perJob', limit: 4, effect: 'limit' },
    });
    // A typed cap is stricter for a job of that model…
    const typed = { ...qos, limits: { ...qos.limits, MaxTRESPJ: 'gres/gpu=4,gres/gpu:a100=2' } };
    expect(optionFor(typed, [], ask(3, 'a100')).rule).toMatchObject({ kind: 'perJob', limit: 2 });
    expect(optionFor(typed, [], ask(3, 'a100')).verdict).toBe('limit');
    // …and leaves a job of unspecified model unchecked.
    expect(optionFor(typed, [], ask(3))).toMatchObject({
      verdict: 'possible',
      rule: { kind: 'typed', limit: 2, effect: 'doubt' },
    });
  });

  it('is at most possible while the use of a GrpTRES GPU limit is unknown', () => {
    // Rows saved before usage was collected have none; missing usage is unknown, not zero.
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'cpu=N,gres/gpu=8', GrpTRES: 'cpu=N,gres/gpu=16' },
      access: 'verified' as const,
      origin: 't',
    };
    const option = optionFor(qos, [], ask(8));
    expect(option).toMatchObject({ freeGpus: 16, headroom: 8, verdict: 'possible' });
    expect(option.rule).toEqual({ kind: 'group', limit: 16, used: null, effect: 'doubt' });
    expect(optionFor({ ...qos, usage: {} }, [], ask(8)).verdict).toBe('possible');
  });

  it('compares a request with what is left of a GrpTRES GPU limit', () => {
    const qos = {
      name: 'normal',
      limits: { MaxTRESPU: 'gres/gpu=8', GrpTRES: 'cpu=N,mem=N,gres/gpu=16' },
      usage: { GrpTRES: 'cpu=0,mem=0,gres/gpu=12' },
      access: 'verified' as const,
      origin: 't',
    };
    expect(optionFor(qos, [], ask(4)).verdict).toBe('likely');
    // Other users hold 12 of the 16: an 8-GPU job waits.
    expect(optionFor(qos, [], ask(8))).toMatchObject({
      verdict: 'busy',
      rule: { kind: 'group', limit: 16, used: 12, effect: 'busy' },
    });
    // More than the whole QoS may ever use cannot start.
    const big = { ...qos, limits: { ...qos.limits, MaxTRESPU: 'gres/gpu=32' } };
    expect(optionFor(big, [], ask(20)).verdict).toBe('limit');
    // "N" is no limit at all.
    const open = { ...qos, limits: { MaxTRESPU: 'gres/gpu=8', GrpTRES: 'gres/gpu=N' } };
    expect(optionFor(open, [], ask(8)).verdict).toBe('likely');
  });
});

describe('clusters without the requested GPUs', () => {
  const qos = {
    name: 'normal',
    limits: { MaxTRESPU: 'gres/gpu=8' },
    access: 'verified' as const,
    origin: 't',
  };
  const b = source({ id: 'b-alice', cluster_id: 'b', name: 'B', qos: [qos] });
  const onB = (name: string, extra: Partial<ComputeNode> = {}) =>
    node(name, { id: `b:${name}`, source_id: 'b-alice', cluster_id: 'b', ...extra });

  it('ranks a cluster whose collected nodes have no such GPUs last', () => {
    const options = planOptions(
      {
        sources: [source({ qos: [qos] }), b],
        // Cluster A has H100s, all in use; cluster B has only A100s.
        nodes: [
          node('h1', { gpu_type: 'h100', gpu_allocated: 8 }),
          onB('a1', { gpu_allocated: 0 }),
        ],
        jobs: [],
      },
      { gpus: 1, gpuType: 'h100', hours: null },
    );
    expect(options.map((o) => [o.source.cluster_id, o.verdict, o.freeGpus])).toEqual([
      ['cluster-a', 'busy', 0],
      ['b', 'none', 0],
    ]);
    expect(options[1].noMatchingGpus).toBe(true);
  });

  it('does not rule a cluster out while some of its GPU nodes have no known model', () => {
    const [option] = planOptions(
      { sources: [b], nodes: [onB('a1'), onB('x', { gpu_type: null })], jobs: [] },
      { gpus: 1, gpuType: 'h100', hours: null },
    );
    expect(option).toMatchObject({ freeGpus: null, noMatchingGpus: false, verdict: 'possible' });
  });

  it('says a CPU-only cluster has no GPUs, and that unhealthy GPUs are not free', () => {
    const cpuOnly = planOptions(
      {
        sources: [b],
        nodes: [onB('c1', { gpu_count: 0, gpu_allocated: 0, gpu_type: null })],
        jobs: [],
      },
      { gpus: 1, gpuType: '', hours: null },
    );
    expect(cpuOnly[0]).toMatchObject({ freeGpus: 0, verdict: 'none' });
    const drained = planOptions(
      { sources: [b], nodes: [onB('a1', { state: 'drain', gpu_allocated: 0 })], jobs: [] },
      { gpus: 1, gpuType: 'a100', hours: null },
    );
    expect(drained[0]).toMatchObject({ freeGpus: 0, noMatchingGpus: false, verdict: 'busy' });
  });
});

it('never upgrades unknown access to likely, and excludes missing grants from viable options', () => {
  const data = {
    sources: [
      source({
        qos: [
          {
            name: 'allowed',
            access: 'verified' as const,
            origin: 'test',
            limits: { MaxTRESPU: 'gres/gpu=8' },
          },
          {
            name: 'uncertain',
            access: 'unknown',
            origin: 'test',
            limits: { MaxTRESPU: 'gres/gpu=8' },
          },
          {
            name: 'other-account',
            access: 'not_associated',
            origin: 'test',
            limits: { MaxTRESPU: 'gres/gpu=8' },
          },
        ],
      }),
    ],
    nodes: [node('a', { gpu_allocated: 0 })],
    jobs: [],
  };
  const options = planOptions(data, { gpus: 1, gpuType: '', hours: null });
  expect(Object.fromEntries(options.map((option) => [option.qos, option.verdict]))).toEqual({
    allowed: 'likely',
    uncertain: 'possible',
    'other-account': 'denied',
  });
});

it('explains unavailable and degraded clusters even with apparently free GPUs', () => {
  for (const [state, verdict] of [
    ['unavailable', 'unavailable'],
    ['degraded', 'possible'],
  ] as const) {
    const [option] = planOptions(
      {
        sources: [source({ cluster_state: state })],
        nodes: [node('a', { gpu_allocated: 0 })],
        jobs: [],
      },
      { gpus: 1, gpuType: '', hours: null },
    );
    expect(option.verdict).toBe(verdict);
  }
});
