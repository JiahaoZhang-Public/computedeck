import { serverClusterState, serverNodeHealth, serverPendingStates } from './test-server';
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
  health: serverNodeHealth(extra.state ?? 'mixed', extra.partitions ?? ['gpu']),
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
    expect(normal.verdict).toBe('behind');
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
    expect(verdicts).toEqual(['possible', 'behind']);
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
    expect(option.verdict).toBe('possible');
    expect(option.contradiction?.reason).toBe('QOSMaxGRESPerUser');
    expect(
      planOptions(
        { ...open, jobs: [job('1'), job('2', { state: 'PENDING', reason: 'Priority' })] },
        { gpus: 4, gpuType: '', hours: null },
      )[0].verdict,
    ).toBe('likely');
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
  it('excludes reserved and powered-down cloud capacity', () => {
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
    expect(option).toMatchObject({ freeGpus: 0, matchingNodes: 0 });
  });
  it('does not count the GPUs of a Slurm INVAL node as free', () => {
    const [option] = planOptions(
      {
        sources: [source()],
        jobs: [],
        nodes: [
          node('bad', { state: 'inval', gpu_allocated: 0 }),
          node('ready', { state: 'idle', gpu_allocated: 0 }),
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

describe('own queue estimates', () => {
  const ask = { gpus: 4, gpuType: '', hours: null };
  const option = (waiting: Partial<Job>[], extra: Partial<Source> = {}, request = ask) =>
    planOptions(
      {
        sources: [source({ qos: [source().qos[0]], ...extra })],
        nodes: [node('g1', { gpu_allocated: 0 }), node('g2', { gpu_allocated: 0 })],
        jobs: [
          job('running'),
          ...waiting.map((row, i) => job(`pending-${i}`, { state: 'PENDING', ...row })),
        ],
      },
      request,
    )[0];

  it('counts only this login and QoS and estimates the room after its queue', () => {
    expect(
      option([
        { gpu_count: 4, reason: 'Priority' },
        { source_id: 'cluster-a-bob', gpu_count: null },
        { qos: 'long', gpu_count: null },
      ]),
    ).toMatchObject({
      headroom: 4,
      queued: 1,
      queuedGpus: 4,
      queuedForRoom: 4,
      headroomAfterQueue: 0,
      verdict: 'behind',
    });
    expect(option([{ gpu_count: 2 }], {}, { ...ask, gpus: 2 })).toMatchObject({
      headroomAfterQueue: 2,
      verdict: 'likely',
    });
    // A personal-limit wait that fits contradicts the collected arithmetic.
    expect(
      option([{ gpu_count: 1, reason: 'QOSMaxGRESPerUser' }], {}, { ...ask, gpus: 2 }).verdict,
    ).toBe('possible');
  });

  it.each([
    'Held',
    'JobHeldUser',
    'JobHeldAdmin',
    'JobHoldMaxRequeue',
    'Dependency',
    'DependencyNeverSatisfied',
    'BeginTime',
    'JobArrayTaskLimit',
  ])('excludes %s even when its GPU demand is unknown', (reason) => {
    expect(option([{ reason, gpu_count: null }])).toMatchObject({
      queued: 0,
      queuedGpus: 0,
      headroomAfterQueue: 4,
      reasons: [],
      verdict: 'likely',
    });
  });

  it.each(['', 'a100'])('subtracts queued jobs only while they fit (%s)', (gpuType) => {
    const qos = [
      { ...source().qos[0], limits: { MaxTRESPU: `gres/gpu${gpuType ? ':a100' : ''}=8` } },
    ];
    const estimate = (used: number, counts: (number | null)[]) =>
      planOptions(
        {
          sources: [source({ qos })],
          nodes: [node('g1', { gpu_allocated: used })],
          jobs: [
            job('running', { gpu_count: used }),
            ...counts.map((gpu_count, i) =>
              job(`waiting-${i}`, { state: 'PENDING', reason: 'Priority', gpu_count }),
            ),
          ],
        },
        { ...ask, gpus: 2, gpuType },
      )[0];
    expect(estimate(2, [4, 4])).toMatchObject({
      headroom: 6,
      queuedGpus: 8,
      queuedForRoom: 4,
      headroomAfterQueue: 2,
      verdict: 'likely',
    });
    expect(estimate(0, [4, 4])).toMatchObject({
      queuedForRoom: 8,
      headroomAfterQueue: 0,
      verdict: 'behind',
    });
    expect(estimate(2, [4, 4, 1])).toMatchObject({
      queuedForRoom: 5,
      headroomAfterQueue: 1,
      verdict: 'behind',
    });
    expect(estimate(2, [4, 4, null])).toMatchObject({
      queuedForRoom: null,
      headroomAfterQueue: null,
      verdict: 'possible',
    });
    expect(estimate(0, [4, 4, null])).toMatchObject({
      queuedGpus: null,
      queuedForRoom: 8,
      headroomAfterQueue: 0,
      verdict: 'behind',
    });
  });

  it('leaves room available while array siblings are throttled', () => {
    expect(
      option(
        Array.from({ length: 46 }, () => ({ gpu_count: 1, reason: 'JobArrayTaskLimit' })),
        {},
        { ...ask, gpus: 2 },
      ),
    ).toMatchObject({ queued: 0, queuedForRoom: 0, headroomAfterQueue: 4, verdict: 'likely' });
  });

  it.each(['', 'a100'])('keeps unlimited room despite unknown queued demand (%s)', (gpuType) => {
    const qos = [
      { ...source().qos[0], limits: { MaxTRESPU: `gres/gpu${gpuType ? ':a100' : ''}=N` } },
    ];
    for (const model of ['a100', 'h100', null]) {
      expect(
        option([{ gpu_type: model, gpu_count: null }], { qos }, { ...ask, gpuType }),
      ).toMatchObject({
        queuedGpus: null,
        headroom: Infinity,
        queuedForRoom: 0,
        headroomAfterQueue: Infinity,
        verdict: 'likely',
      });
    }
  });

  it.each(serverPendingStates())('counts server pending alias %s', (state) => {
    expect(option([{ state, gpu_count: 4 }]).verdict).toBe('behind');
  });

  it.each(['', 'a100'])(
    'lets a smaller request overtake a larger limit-held job (%s)',
    (gpuType) => {
      const qos = [
        { ...source().qos[0], limits: { MaxTRESPU: `gres/gpu${gpuType ? ':a100' : ''}=8` } },
      ];
      expect(
        option([{ gpu_count: 8, reason: 'QOSMaxGRESPerUser' }], { qos }, { ...ask, gpuType }),
      ).toMatchObject({
        headroom: 4,
        queued: 1,
        queuedGpus: 8,
        queuedForRoom: 0,
        headroomAfterQueue: 4,
        verdict: 'likely',
      });
      expect(
        option([{ gpu_count: 8 }, { gpu_count: null }], { qos }, { ...ask, gpuType }),
      ).toMatchObject({ headroomAfterQueue: null, verdict: 'possible' });
    },
  );

  it.each(['', 'a100'])(
    'does not subtract admitted pending pods from quota usage again (%s)',
    (gpuType) => {
      const tres = `gres/gpu${gpuType ? ':a100' : ''}`;
      const qos = [
        {
          ...source().qos[0],
          name: 'team',
          origin: 'kubernetes_resource_quota',
          limits: { MaxTRESPU: `${tres}=8`, UsedTRESPU: `${tres}=6` },
        },
      ];
      expect(
        planOptions(
          {
            sources: [source({ qos, driver: 'kubernetes' })],
            nodes: [node('g1')],
            jobs: [
              job('running', { qos: 'team', gpu_count: 2 }),
              job('waiting', { qos: 'team', state: 'PENDING', gpu_count: 4 }),
            ],
          },
          { ...ask, gpus: 2, gpuType },
        )[0],
      ).toMatchObject({
        used: 6,
        headroom: 2,
        queued: 1,
        queuedForRoom: 0,
        headroomAfterQueue: 2,
        verdict: 'likely',
      });
    },
  );

  it('keeps unknown GPU demand unknown but preserves definite limits', () => {
    expect(option([{ gpu_count: null }])).toMatchObject({
      queued: 1,
      queuedGpus: null,
      headroomAfterQueue: null,
      verdict: 'possible',
    });
    expect(option([{ gpu_count: null }], {}, { ...ask, gpus: 8 }).verdict).toBe('limit');
  });

  it.each([
    { stale: true },
    { error: { code: 'ssh_timeout' } },
    { capabilities: ['nodes', 'qos_limits', 'qos_access'] },
  ])('does not use a noncurrent queue: %j', (extra) => {
    expect(option([{ gpu_count: 12, reason: 'Priority' }], extra)).toMatchObject({
      queued: null,
      queuedGpus: null,
      headroomAfterQueue: null,
      reasons: null,
    });
    expect(option([], extra).verdict).not.toBe('likely');
  });

  it('counts every model against a total cap and matching models against typed caps', () => {
    const qos = [{ ...source().qos[0], limits: { MaxTRESPU: 'gres/gpu=16,gres/gpu:a100=8' } }];
    const request = { ...ask, gpuType: 'a100' };
    expect(option([{ gpu_type: 'h100', gpu_count: 8 }], { qos }, request)).toMatchObject({
      headroom: 4,
      headroomAfterQueue: 4,
      verdict: 'likely',
    });
    expect(option([{ gpu_type: 'h100', gpu_count: 10 }], { qos }, request)).toMatchObject({
      headroom: 4,
      queuedForRoom: 2,
      headroomAfterQueue: 2,
      verdict: 'behind',
    });
    expect(option([{ gpu_type: 'a100', gpu_count: 2 }], { qos }, request)).toMatchObject({
      headroomAfterQueue: 2,
      verdict: 'behind',
    });
    expect(option([{ gpu_type: null, gpu_count: 2 }], { qos }, request)).toMatchObject({
      headroomAfterQueue: null,
      verdict: 'possible',
    });
    const typedOnly = [{ ...qos[0], limits: { MaxTRESPU: 'gres/gpu:a100=8' } }];
    expect(
      option(
        [
          { gpu_type: 'h100', gpu_count: 8 },
          { gpu_type: 'a100', gpu_count: 2 },
        ],
        { qos: typedOnly },
        request,
      ),
    ).toMatchObject({
      headroom: 4,
      queuedGpus: 10,
      queuedForRoom: 2,
      headroomAfterQueue: 2,
      verdict: 'behind',
    });
  });

  it('keeps held jobs in the submission limit even though they do not compete for GPUs', () => {
    expect(
      option([{ reason: 'JobHeldUser' }], {
        qos: [
          {
            ...source().qos[0],
            limits: { MaxTRESPU: 'gres/gpu=8', MaxSubmitJobsPU: '2' },
          },
        ],
      }),
    ).toMatchObject({ queued: 0, verdict: 'limit', rule: { kind: 'submit' } });
  });

  it('prefers a one-node fit before headroom or total free GPUs', () => {
    const second = source({ id: 'b', cluster_id: 'b', qos: [source().qos[0]] });
    const options = planOptions(
      {
        sources: [source({ qos: [source().qos[0]] }), second],
        jobs: [],
        nodes: [
          node('g1', { gpu_allocated: 4 }),
          ...[1, 2, 3].map((i) =>
            node(`b${i}`, { id: `b:${i}`, source_id: 'b', cluster_id: 'b', gpu_allocated: 5 }),
          ),
        ],
      },
      ask,
    );
    expect(options.map((row) => row.source.id)).toEqual(['cluster-a-alice', 'b']);
  });

  it('sorts equal verdicts by room after the queue, then free GPUs, then verified access', () => {
    const base = source().qos[0];
    const options = planOptions(
      {
        sources: [
          source({
            cluster_state: 'degraded', // All options stay possible, including verified access.
            qos: [
              { ...base, name: 'a-unchecked', access: 'unknown' },
              { ...base, name: 'b-verified' },
              { ...base, name: 'c-roomy' },
            ],
          }),
        ],
        nodes: [node('g1')],
        jobs: [
          job('1', { state: 'PENDING', qos: 'a-unchecked', gpu_count: 2 }),
          job('2', { state: 'PENDING', qos: 'b-verified', gpu_count: 2 }),
        ],
      },
      ask,
    );
    expect(options.map((row) => row.verdict)).toEqual(['possible', 'possible', 'possible']);
    expect(options.map((row) => row.qos)).toEqual(['c-roomy', 'b-verified', 'a-unchecked']);
    expect(options.map((row) => row.headroomAfterQueue)).toEqual([8, 6, 6]);

    const moreFree = source({ id: 'z', cluster_id: 'z', qos: [base] });
    const freeOptions = planOptions(
      {
        sources: [source({ qos: [base] }), moreFree],
        nodes: [
          node('g1'),
          node('z1', { id: 'z:1', cluster_id: 'z', source_id: 'z', gpu_allocated: 0 }),
        ],
        jobs: [],
      },
      ask,
    );
    expect(freeOptions.map((row) => row.headroomAfterQueue)).toEqual([8, 8]);
    expect(freeOptions.map((row) => row.source.id)).toEqual(['z', 'cluster-a-alice']);
  });
});

it('does not let a CPU-only queued job consume or obscure a typed GPU cap', () => {
  const login = source({
    qos: [
      {
        name: 'normal',
        access: 'verified',
        origin: 'test',
        limits: { MaxTRESPU: 'gres/gpu:a100=4' },
        usage: { MaxTRESPU: 'gres/gpu:a100=0' },
      },
    ],
  });
  const [option] = planOptions(
    {
      sources: [login],
      nodes: [node('idle', { gpu_allocated: 0 })],
      jobs: [job('cpu', { state: 'PENDING', gpu_count: 0, gpu_type: null, reason: 'Priority' })],
    },
    { gpus: 2, gpuType: 'a100', hours: null },
  );
  expect(option.verdict).toBe('likely');
  expect(option.queuedForRoom).toBe(0);
  expect(option.headroomAfterQueue).toBe(4);
});

it.each([{ health: 'unknown' as const }, { gpu_count: null }])(
  'keeps unmeasured matching capacity unknown: %s',
  (unknown) => {
    const [option] = planOptions(
      {
        sources: [source()],
        nodes: [
          node('full', { gpu_allocated: 8 }),
          node('unmeasured', { gpu_allocated: 0, ...unknown }),
        ],
        jobs: [],
      },
      { gpus: 2, gpuType: 'a100', hours: null },
    );
    expect(option.freeGpus).toBeNull();
    expect(option.verdict).toBe('possible');
  },
);

it.each(['R', 'CF', 'CG'])('counts %s allocation against planner limits', (state) => {
  const [option] = planOptions(
    {
      sources: [source({ qos: [source().qos[0]] })],
      nodes: [node('idle', { gpu_allocated: 0 })],
      jobs: [job('running', { state, gpu_count: 8 })],
    },
    { gpus: 2, gpuType: '', hours: null },
  );
  expect(option.used).toBe(8);
  expect(option.headroom).toBe(0);
  expect(option.verdict).toBe('limit');
});

it.each([{ health: 'unknown' as const }, { gpu_count: null }, { gpu_allocated: null }])(
  'keeps enough known free GPUs as a lower bound beside uncertain capacity: %s',
  (unknown) => {
    const [option] = planOptions(
      {
        sources: [source()],
        nodes: [node('idle', { gpu_allocated: 0 }), node('unmeasured', unknown)],
        jobs: [],
      },
      { gpus: 2, gpuType: 'a100', hours: null },
    );
    expect(option).toMatchObject({ freeGpus: 8, freeGpusPartial: true, verdict: 'likely' });
  },
);

it.each([
  { state: 'idle', partitions: [] },
  { state: 'IDLE+CLOUD+POWERED_DOWN', partitions: ['gpu'] },
  { state: 'IDLE+CLOUD+POWERED_DOWN', partitions: [] },
  { state: 'IDLE+CLOUD+POWERING_UP', partitions: ['gpu'] },
  { state: 'FUTURE', partitions: ['gpu'] },
  { state: 'ERROR', partitions: ['gpu'] },
  { state: 'provisioning', partitions: ['gpu'] },
  { state: 'sleep', partitions: ['gpu'] },
  { state: 'wait-provisioning', partitions: ['gpu'] },
])('uses the server classifier to exclude $state ($partitions) from free GPUs', (extra) => {
  const nodes = [node('g1', { ...extra, gpu_type: 'h100', gpu_allocated: 0 })];
  const sources = [source()];
  const request = { gpus: 1, gpuType: 'h100', hours: null };
  const options = planOptions({ sources, nodes, jobs: [] }, request);
  for (const option of options) {
    expect(option.freeGpus).toBe(0);
    expect(option.matchingNodes).toBe(0);
    expect(option.freeGpusPartial).toBe(false);
    expect(option.verdict).not.toBe('likely');
  }
  const mixed = planOptions(
    { sources, nodes: [...nodes, node('g2', { gpu_type: 'h100', gpu_allocated: 2 })], jobs: [] },
    request,
  );
  expect(mixed[0].freeGpus).toBe(6);
  expect(mixed[0].matchingNodes).toBe(1);
  expect(mixed[0].freeGpusPartial).toBe(false);
});

it.each([
  'IDLE+CLOUD+POWERED_DOWN',
  'IDLE+POWERED_DOWN',
  'IDLE+POWERING_DOWN',
  'IDLE+POWER_DOWN',
  'IDLE+POWERING_UP',
  'IDLE+POWER_UP',
  'IDLE+CLOUD+POWERING_UP',
  'sleep',
  'provisioning',
  'wait-provisioning',
  'free+sleep',
])('does not mark a power-saving cluster (%s) as down or free', (state) => {
  const nodes = [node('saving', { state, gpu_allocated: 0 })];
  const cluster_state = serverClusterState(nodes);
  expect(cluster_state).toBe('available');
  const options = planOptions(
    { sources: [source({ cluster_state })], nodes, jobs: [] },
    { gpus: 1, gpuType: '', hours: null },
  );
  for (const option of options) {
    expect(option.freeGpus).toBe(0);
    expect(option.verdict).not.toBe('unavailable');
    expect(option.verdict).not.toBe('likely');
  }
});

it.each([
  { gpu_type: 'A100', gpu_count: 8, gpuType: 'H100', expected: 0 },
  { gpu_type: 'A100', gpu_count: 8, gpuType: 'a100', expected: 8 },
  { gpu_type: null, gpu_count: 8, gpuType: 'h100', expected: null },
  { gpu_type: 'h100', gpu_count: null, gpuType: 'h100', expected: null },
  { gpu_type: 'a100,h100', gpu_count: 8, gpuType: 'h100', expected: null },
  { gpu_type: null, gpu_count: 8, gpuType: '', expected: 8 },
  { gpu_type: null, gpu_count: null, gpuType: '', expected: null },
])(
  'counts on-demand GPUs only for the requested model: %s',
  ({ gpu_type, gpu_count, gpuType, expected }) => {
    const options = planOptions(
      {
        sources: [source()],
        nodes: [
          node('resting', {
            state: 'IDLE+CLOUD+POWERED_DOWN',
            gpu_type,
            gpu_count,
            gpu_allocated: 0,
          }),
        ],
        jobs: [],
      },
      { gpus: 1, gpuType, hours: null },
    );
    for (const option of options) expect(option.onDemandGpus).toBe(expected);
  },
);

describe('honest ranking', () => {
  const ask = { gpus: 2, gpuType: '', hours: null };
  const estimate = (waiting: Partial<Job>, gpuType = '', extra: Partial<Source> = {}) =>
    planOptions(
      {
        sources: [
          source({
            qos: [
              {
                ...source().qos[0],
                limits: { MaxTRESPU: gpuType ? 'gres/gpu=12,gres/gpu:a100=8' : 'gres/gpu=8' },
              },
            ],
            ...extra,
          }),
        ],
        nodes: [node('g1', { gpu_allocated: 0 })],
        jobs: [
          job('running'),
          job('waiting', {
            state: 'PENDING',
            gpu_count: 1,
            reason: 'QOSMaxGRESPerUser',
            ...waiting,
          }),
        ],
      },
      { ...ask, gpuType },
    )[0];

  it.each(['', 'a100'])('caps a contradictory personal-limit wait for %s', (model) => {
    expect(estimate({}, model)).toMatchObject({
      headroom: 4,
      headroomAfterQueue: 3,
      verdict: 'possible',
      contradiction: { job: 'train', reason: 'QOSMaxGRESPerUser' },
    });
    expect(estimate({ gpu_count: 12 }, model)).toMatchObject({
      verdict: 'likely',
      contradiction: null,
      headroomAfterQueue: 4,
    });
    expect(estimate({ gpu_count: 4 }, model)).toMatchObject({ verdict: 'behind' });
    expect(estimate({ gpu_count: null }, model).contradiction).toBeNull();
    expect(estimate({ reason: 'JobHeldUser', gpu_count: 8 }, model)).toMatchObject({
      verdict: 'likely',
      contradiction: null,
    });
  });

  it.each([
    ['QOSMaxJobsPerUserLimit', 'MaxJobsPU', 1],
    ['AssocMaxJobsLimit', 'MaxJobsPU', 1],
    ['QOSMaxSubmitJobPerUserLimit', 'MaxSubmitJobsPU', 2],
    ['AssocMaxSubmitJobLimit', 'MaxSubmitJobsPU', 2],
  ] as const)('caps %s unless a collected count rule already binds', (reason, key, used) => {
    const check = (cap: string | undefined, usage?: Record<string, string>) =>
      estimate({ reason: `${reason} (details)` }, '', {
        qos: [
          {
            ...source().qos[0],
            limits: { MaxTRESPU: 'gres/gpu=8', ...(cap === undefined ? {} : { [key]: cap }) },
            usage,
          },
        ],
      });
    expect(check(String(used + 1))).toMatchObject({
      verdict: 'possible',
      contradiction: { reason: `${reason} (details)` },
    });
    expect(check(String(used))).toMatchObject({ verdict: 'limit', contradiction: null });
    for (const cap of [undefined, 'N'])
      expect(check(cap)).toMatchObject({
        verdict: 'possible',
        contradiction: { reason: `${reason} (details)` },
      });
    // Scheduler counts take precedence, in both directions.
    expect(check(String(used + 1), { [key]: String(used + 1) })).toMatchObject({
      verdict: 'limit',
      contradiction: null,
    });
    expect(check(String(used), { [key]: '0' })).toMatchObject({
      verdict: 'possible',
      contradiction: { reason: `${reason} (details)` },
    });
  });

  it.each(['MaxJobsPU', 'MaxSubmitJobsPU'])('does not contradict a reached %s rule', (key) => {
    for (const reason of [
      'QOSMaxGRESPerUser',
      'QOSMaxJobsPerUserLimit',
      'QOSMaxSubmitJobPerUserLimit',
      'AssocMaxJobsLimit',
      'AssocMaxSubmitJobLimit',
    ]) {
      expect(
        estimate({ reason }, '', {
          qos: [
            {
              ...source().qos[0],
              limits: {
                MaxTRESPU: 'gres/gpu=8',
                MaxJobsPU: '10',
                MaxSubmitJobsPU: '10',
                [key]: '1',
              },
            },
          ],
        }),
      ).toMatchObject({ verdict: 'limit', contradiction: null });
    }
  });

  it.each(['', 'a100'])('ignores zero-GPU GRES waits for %s', (model) => {
    expect(estimate({ gpu_count: 0, gpu_type: null }, model)).toMatchObject({
      headroom: 4,
      queuedForRoom: 0,
      verdict: 'likely',
      contradiction: null,
    });
  });

  it.each([
    'QOSMaxJobsPerUserLimit',
    'QOSMaxSubmitJobPerUserLimit',
    'AssocMaxJobsLimit',
    'AssocMaxSubmitJobLimit',
  ])('retains a zero-GPU job as evidence for %s without a collected count cap', (reason) => {
    expect(estimate({ reason, gpu_count: 0, gpu_type: null })).toMatchObject({
      verdict: 'possible',
      contradiction: { reason },
    });
  });

  it.each(['QOSMaxCpuPerUserLimit', 'AssocMaxCpuPerUserLimit', 'AssocMaxGRESPerUser'])(
    'does not infer room for unevaluated or undocumented reason %s',
    (reason) => {
      expect(estimate({ reason })).toMatchObject({ verdict: 'likely', contradiction: null });
    },
  );

  it.each(['h100', null, 'a100,h100'])(
    'does not test a %s wait against a different model headroom',
    (gpu_type) => {
      const [option] = planOptions(
        {
          sources: [
            source({
              qos: [
                {
                  ...source().qos[0],
                  limits: {
                    MaxTRESPU: 'gres/gpu=16,gres/gpu:h100=4',
                  },
                },
              ],
            }),
          ],
          nodes: [node('g1', { gpu_allocated: 0 })],
          jobs: [
            job('running', { gpu_type: 'h100', gpu_count: 4 }),
            job('waiting', {
              gpu_type,
              state: 'PENDING',
              gpu_count: 1,
              reason: 'QOSMaxGRESPerUser',
            }),
          ],
        },
        { gpus: 2, gpuType: 'a100', hours: null },
      );
      expect(option).toMatchObject({ headroom: 12, verdict: 'likely', contradiction: null });
    },
  );

  it('does not infer a contradiction from stale, unrelated or unknown evidence', () => {
    for (const extra of [
      { stale: true },
      { capabilities: ['nodes', 'qos_limits', 'qos_access'] },
      { capabilities: ['jobs', 'nodes', 'qos_access'] },
      { driver: 'pbs' },
    ])
      expect(estimate({}, '', extra).contradiction).toBeNull();
    expect(estimate({ qos: 'other' }).contradiction).toBeNull();
    expect(estimate({ source_id: 'other-login' }).contradiction).toBeNull();
    expect(estimate({ reason: 'Priority' }).verdict).toBe('likely');
    for (const gpu_type of [null, 'h100', 'a100,h100'])
      expect(estimate({ gpu_type }, 'a100').contradiction).toBeNull();
    expect(
      estimate({}, '', { qos: [{ ...source().qos[0], origin: 'kubernetes_resource_quota' }] }),
    ).toMatchObject({
      verdict: 'likely',
      queuedForRoom: 0,
      contradiction: null,
    });
  });

  it('caps a contradiction with only a typed GPU limit', () => {
    expect(
      estimate({}, 'a100', {
        qos: [{ ...source().qos[0], limits: { MaxTRESPU: 'gres/gpu:a100=8' } }],
      }),
    ).toMatchObject({
      used: 4,
      headroom: 4,
      headroomAfterQueue: 3,
      verdict: 'possible',
      contradiction: { job: 'train', reason: 'QOSMaxGRESPerUser' },
    });
  });

  it('does not turn stale twin jobs into current queue evidence', () => {
    const current = source({ id: 'second-alice', last_success: '2026-01-01T01:00:00Z' });
    const [option] = planOptions(
      {
        sources: [source({ stale: true }), current],
        nodes: [node('g1', { source_id: current.id })],
        jobs: [job('old-wait', { state: 'PENDING', gpu_count: 1, reason: 'QOSMaxGRESPerUser' })],
      },
      ask,
    );
    expect(option).toMatchObject({
      source: { id: current.id },
      used: 0,
      queued: 0,
      contradiction: null,
      verdict: 'likely',
    });
  });

  it.each([false, true])(
    'uses current twin jobs when the kept QoS source lacks current jobs (%s)',
    (reverse) => {
      const limits = source({
        capabilities: ['nodes', 'qos_limits', 'qos_access'],
        qos: [source().qos[0]],
      });
      const jobs = source({
        id: 'second-alice',
        capabilities: ['jobs'],
        qos: [source().qos[0]],
      });
      const sources = [limits, jobs];
      const options = planOptions(
        {
          sources: reverse ? sources.reverse() : sources,
          nodes: [node('g1')],
          jobs: [
            job('stale-running', { gpu_count: 8 }),
            job('running', { source_id: jobs.id }),
            job('waiting', {
              source_id: jobs.id,
              state: 'PENDING',
              gpu_count: 1,
              reason: 'AssocMaxJobsLimit',
            }),
          ],
        },
        ask,
      );
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({
        source: { id: limits.id },
        used: 4,
        headroom: 4,
        queued: 1,
        queuedGpus: 1,
        headroomAfterQueue: 3,
        contradiction: { job: 'train', reason: 'AssocMaxJobsLimit' },
        verdict: 'possible',
      });
    },
  );

  it.each([0, 1, null])(
    'keeps zero-GPU running jobs out of typed use, preserving unknowns (%s)',
    (gpu_count) => {
      const [option] = planOptions(
        {
          sources: [
            source({ qos: [{ ...source().qos[0], limits: { MaxTRESPU: 'gres/gpu:a100=8' } }] }),
          ],
          nodes: [node('g1')],
          jobs: [job('gpu'), job('cpu', { gpu_count, gpu_type: null })],
        },
        { ...ask, gpuType: 'a100' },
      );
      expect(option.headroom).toBe(gpu_count === 0 ? 4 : null);
      expect(option.verdict).toBe(gpu_count === 0 ? 'likely' : 'possible');
    },
  );

  it.each([false, true])('prefers a current twin over a newer failed twin (%s)', (reverse) => {
    const current = source({ last_success: '2026-01-01T10:00:00Z', qos: [source().qos[0]] });
    const failed = source({
      id: 'second-alice',
      last_success: '2026-01-01T10:02:00Z',
      last_attempt: '2026-01-01T10:07:00Z',
      status: 'error',
      error: { code: 'ssh_failed' },
      stale: false,
      qos: [source().qos[0]],
    });
    const sources = [current, failed];
    const options = planOptions(
      {
        sources: reverse ? sources.reverse() : sources,
        nodes: [node('g1')],
        jobs: [
          job('running'),
          job('waiting', { state: 'PENDING', gpu_count: 1, reason: 'Priority' }),
        ],
      },
      ask,
    );
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      source: { id: current.id },
      qos: 'normal',
      limit: 8,
      used: 4,
      headroom: 4,
      queued: 1,
      queuedGpus: 1,
      queuedForRoom: 1,
      headroomAfterQueue: 3,
      verdict: 'likely',
    });
  });

  it.each([false, true])(
    'omits an empty twin QoS row regardless of freshness (%s)',
    (emptyFirst) => {
      const populated = source({ last_success: '2026-01-01T01:00:00Z' });
      const empty = source({
        id: 'empty-twin',
        qos: [],
        last_success: emptyFirst ? '2026-01-01T02:00:00Z' : null,
      });
      const options = planOptions({ sources: [empty, populated], nodes: [], jobs: [] }, ask);
      expect(options.map((option) => option.qos).sort()).toEqual(['long', 'normal']);
      const otherUser = { ...empty, username: 'bob' };
      const separate = planOptions({ sources: [otherUser, populated], nodes: [], jobs: [] }, ask);
      expect(separate.filter((option) => option.qos == null)).toHaveLength(1);
      expect(planOptions({ sources: [empty], nodes: [], jobs: [] }, ask)[0].qos).toBeNull();
    },
  );

  it.each([false, true])(
    'merges twins per QoS, attributing jobs regardless of source order (%s)',
    (reverse) => {
      const old = source({ last_success: '2026-01-01T00:00:00Z' });
      const newer = source({
        id: 'second-alice',
        name: 'Second login',
        last_success: '2026-01-01T01:00:00Z',
        qos: [source().qos[0]],
      });
      const bob = source({ id: 'bob', username: 'bob' });
      const disabled = source({
        id: 'disabled',
        enabled: false,
        last_success: '2026-01-01T02:00:00Z',
      });
      const sources = [old, newer, bob, disabled];
      const options = planOptions(
        {
          sources: reverse ? sources.reverse() : sources,
          nodes: [node('g1', { gpu_allocated: 0 })],
          jobs: [
            job('running'),
            job('waiting', { state: 'PENDING', gpu_count: 1, reason: 'QOSMaxGRESPerUser' }),
          ],
        },
        ask,
      );
      expect(options).toHaveLength(4);
      expect(
        options.find((o) => o.source.username === 'alice' && o.qos === 'normal'),
      ).toMatchObject({
        source: { id: newer.id },
        used: 4,
        queued: 1,
        verdict: 'possible',
        contradiction: { job: 'train', reason: 'QOSMaxGRESPerUser' },
      });
      expect(
        options.find((o) => o.source.username === 'alice' && o.qos === 'long')?.source.id,
      ).toBe(old.id);
      expect(options.find((o) => o.source.username === 'bob' && o.qos === 'normal')).toMatchObject({
        used: 0,
        queued: 0,
        verdict: 'likely',
      });
    },
  );

  it.each([false, true])(
    'counts duplicated jobs once using their newest observation (%s)',
    (reverse) => {
      const newer = source({ id: 'second-alice', last_success: '2026-01-01T01:00:00Z' });
      const jobs = [
        job('same', {
          source_id: newer.id,
          state: 'PENDING',
          gpu_count: 1,
          reason: 'QOSMaxGRESPerUser',
          observed_at: '2026-01-01T00:00:00Z',
        }),
        job('same', { observed_at: '2026-01-01T01:00:00Z' }),
      ];
      const [option] = planOptions(
        { sources: [source(), newer], nodes: [node('g1')], jobs: reverse ? jobs.reverse() : jobs },
        ask,
      );
      expect(option).toMatchObject({
        source: { id: newer.id },
        used: 4,
        queued: 0,
        contradiction: null,
        verdict: 'likely',
      });
    },
  );
});
