import { describe, expect, it } from 'vitest';
import {
  runningPrice,
  currentJobs,
  partialCount,
  elapsedSeconds,
  sortJobs,
  historyAllocation,
  historyPartial,
  jobCount,
  jobGpuResources,
  jobsMissing,
  listedJobs,
  knownSum,
  percentage,
  summarize,
  summarizeNodes,
  uniqueJobs,
  uniqueNodes,
} from './domain';
import type { ComputeNode, Dashboard, HistoryPoint, Instance, Job, Source } from './types';

const job = (extra: Partial<Job>): Job => ({
  id: 'cluster-a:42',
  source_id: 'one',
  cluster_id: 'cluster-a',
  name: 'training',
  user: 'alice',
  account: 'a',
  partition: 'gpu',
  qos: 'q',
  state: 'RUNNING',
  gpu_count: 4,
  gpu_type: 'A100',
  cpu_count: 16,
  node: 'node1',
  elapsed: '1:00',
  reason: null,
  gpu_utilization: null,
  cpu_utilization: null,
  memory_utilization: null,
  observed_at: null,
  ...extra,
});
const dashboard = (jobs: Job[]): Dashboard => ({
  mode: 'live',
  jobs,
  sources: [...new Set(jobs.map((item) => item.source_id))].map((id) => source({ id })),
  instances: [],
  nodes: [],
  history: [],
  updated_at: null,
  refreshing: false,
});
const source = (extra: Partial<Source>): Source => ({
  id: 'one',
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
  capabilities: ['jobs'],
  qos: [],
  ...extra,
});
const instance = (extra: Partial<Instance>): Instance => ({
  id: 'pod',
  source_id: 'cloud',
  platform: 'RunPod',
  name: 'research',
  state: 'desired_running',
  gpu_count: 4,
  gpu_type: 'A100',
  gpu_utilization: 80,
  gpu_observed_count: 2,
  cpu_utilization: 30,
  memory_utilization: 40,
  host: 'example.test',
  port: 22,
  username: 'root',
  ssh_alias: 'cd-pod',
  identity_file: null,
  hourly_cost: null,
  currency: 'USD',
  observed_at: new Date().toISOString(),
  ssh_status: 'reachable',
  ...extra,
});
describe('allocation accounting', () => {
  it('deduplicates observations across accounts and preserves cross-cluster IDs', () => {
    const jobs = [
      job({}),
      job({ source_id: 'two' }),
      job({ id: 'cluster-b:42', cluster_id: 'cluster-b' }),
      job({ id: 'cluster-c:42', cluster_id: 'cluster-c' }),
    ];
    expect(uniqueJobs(jobs)).toHaveLength(3);
    expect(summarize(dashboard(jobs)).allocated).toBe(12);
  });
  it('keeps pending GPU requests out of allocated totals', () => {
    const result = summarize(
      dashboard([job({}), job({ id: '43', state: 'PENDING', gpu_count: 8 })]),
    );
    expect(result.allocated).toBe(4);
    expect(result.requested).toBe(8);
  });
  it('includes completing jobs while the scheduler still holds their resources', () => {
    const result = summarize(
      dashboard([job({}), job({ id: '43', state: 'COMPLETING', gpu_count: 2 })]),
    );
    expect(result.allocated).toBe(6);
    expect(result.running).toBe(2);
  });
  it('counts jobs that are starting on their nodes as holding GPUs', () => {
    const result = summarize(
      dashboard([job({}), job({ id: '43', state: 'CONFIGURING', gpu_count: 8 })]),
    );
    expect(result.allocated).toBe(12);
    expect(result.knownAllocated).toBe(12);
    expect(result.running).toBe(2);
    expect(result.pending).toBe(0);
    expect(jobGpuResources(job({ state: 'CONFIGURING', gpu_count: 8 }))).toEqual({
      allocated: 8,
      requested: null,
    });
  });
  it('weights observed utilization by GPU count without treating missing samples as zero', () => {
    const result = summarize(
      dashboard([
        job({ gpu_utilization: 80 }),
        job({ id: '43', gpu_count: 8 }),
        job({ id: '44', gpu_count: 2, gpu_utilization: 20 }),
      ]),
    );
    expect(result.utilization).toBe(60);
    expect(result.covered).toBe(6);
    expect(result.allocated).toBe(14);
  });
  it('preserves unknown allocations and legitimate zero readings', () => {
    expect(knownSum([4, null])).toBeNull();
    expect(percentage(null)).toBe('—');
    expect(percentage(0)).toBe('0%');
    expect(summarize(dashboard([])).allocated).toBeNull();
  });
  it('excludes retained snapshots of disabled sources from current totals', () => {
    const data = dashboard([job({ source_id: 'disabled' }), job({ id: '43' })]);
    data.sources = [source({ id: 'disabled', enabled: false }), source({})];
    expect(summarize(data).allocated).toBe(4);
    expect(summarize(data).running).toBe(1);
  });
  it('keeps valid cloud samples while lifecycle allocation remains unknown', () => {
    const data = dashboard([job({ gpu_utilization: 50 })]);
    data.instances = [instance({})];
    const result = summarize(data);
    expect(result.allocated).toBeNull();
    expect(result.covered).toBe(6);
    expect(result.utilization).toBe(60);
  });
  it.each(['cluster-a', 'cluster-b'])(
    'does not present stale or first-poll %s totals as a complete allocation',
    (cluster_id) => {
      const data = dashboard([job({ gpu_utilization: 75, cluster_id })]);
      data.sources = [source({ cluster_id, stale: true })];
      expect(summarize(data).allocated).toBeNull();
      expect(summarize(data).utilization).toBeNull();
      data.sources = [source({ cluster_id, last_success: null })];
      expect(summarize(data).allocated).toBeNull();
      expect(summarize(data).utilization).toBeNull();
    },
  );
  it('keeps a fresh prior snapshot visible during an active source refresh', () => {
    const data = dashboard([job({ gpu_utilization: 80 })]);
    data.sources = [source({ status: 'syncing' })];
    expect(summarize(data).allocated).toBe(4);
    expect(summarize(data).utilization).toBe(80);
  });
  it('does not treat a successful cloud sync as an observed empty cluster queue', () => {
    const data = dashboard([]);
    data.sources = [
      source({ enabled: false, last_success: null, status: 'unconfigured' }),
      source({ id: 'runpod', driver: 'runpod', cluster_id: 'runpod', kind: 'cloud' }),
    ];
    const result = summarize(data);
    expect(result.running).toBeNull();
    expect(result.pending).toBeNull();
    expect(result.requested).toBeNull();
  });
  it('keeps fresh cluster job counts available when the cloud API fails', () => {
    const data = dashboard([job({}), job({ id: '43', state: 'PENDING', gpu_count: 8 })]);
    data.sources.push(
      source({
        id: 'runpod',
        driver: 'runpod',
        cluster_id: 'runpod',
        kind: 'cloud',
        status: 'error',
      }),
    );
    const result = summarize(data);
    expect(result.running).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.requested).toBe(8);
    expect(result.allocated).toBeNull();
  });
  it('keeps manual SSH samples independent from a disabled API source', () => {
    const data = dashboard([]);
    data.sources = [source({ id: 'cloud', driver: 'runpod', kind: 'cloud', enabled: false })];
    data.instances = [instance({ platform: 'Lab workstation', manual: true })];
    expect(summarize(data).covered).toBe(2);
    expect(summarize(data).utilization).toBe(80);
    expect(summarize(data).allocated).toBeNull();
  });
  it('does not include expired cloud measurements in utilization', () => {
    const data = dashboard([]);
    data.instances = [instance({ observed_at: new Date(Date.now() - 3600000).toISOString() })];
    expect(summarize(data).covered).toBe(0);
    expect(summarize(data).utilization).toBeNull();
  });
  it('keeps a fresh subtotal while retaining stale source rows and an unknown complete total', () => {
    const data = dashboard([job({}), job({ id: '43', source_id: 'stale', gpu_count: 8 })]);
    data.sources = [source({}), source({ id: 'stale', stale: true })];
    const result = summarize(data);
    expect(result.knownAllocated).toBe(4);
    expect(result.unknownAllocationSources).toBe(1);
    expect(result.allocated).toBeNull();
    expect(data.jobs).toHaveLength(2);
  });
  it('counts unknown allocation sources once even when several jobs lack GPU counts', () => {
    const data = dashboard([
      job({}),
      job({ id: '43', source_id: 'unknown', gpu_count: null }),
      job({ id: '44', source_id: 'unknown', gpu_count: null }),
    ]);
    const result = summarize(data);
    expect(result.knownAllocated).toBe(4);
    expect(result.unknownAllocationSources).toBe(1);
    expect(result.allocated).toBeNull();
  });
  it('requires a current jobs capability but accepts useful partial source data', () => {
    const data = dashboard([job({})]);
    data.sources = [source({ capabilities: ['nodes'] })];
    expect(summarize(data).knownAllocated).toBeNull();
    expect(summarize(data).unknownAllocationSources).toBe(1);
    data.sources = [source({ capabilities: ['jobs'], warnings: ['Nodes are unavailable'] })];
    expect(summarize(data).knownAllocated).toBe(4);
    expect(summarize(data).allocated).toBe(4);
  });
  it('does not treat a fresh SSH sample as proof of a manual instance lifecycle', () => {
    const data = dashboard([job({})]);
    data.sources.push(source({ id: 'cloud', kind: 'cloud', driver: 'runpod', enabled: false }));
    data.instances = [instance({ state: 'running', manual: true })];
    const result = summarize(data);
    expect(result.knownAllocated).toBe(4);
    expect(result.unknownAllocationSources).toBe(1);
    expect(result.allocated).toBeNull();
    expect(result.covered).toBe(2);
  });
  it('keeps missing instances unknown instead of turning them into deletions', () => {
    const data = dashboard([job({})]);
    data.instances = [instance({ state: 'missing' })];
    expect(summarize(data).knownAllocated).toBe(4);
    expect(summarize(data).allocated).toBeNull();
    expect(summarize(data).unknownAllocationSources).toBe(1);
    expect(data.instances[0].state).toBe('missing');
  });
  it('does not turn all-unknown pending GPU demand into zero', () => {
    const data = dashboard([job({ state: 'PENDING', gpu_count: null })]);
    expect(summarize(data).knownRequested).toBeNull();
    expect(summarize(data).requested).toBeNull();
    data.jobs.push(job({ id: '43', state: 'PENDING', gpu_count: 8 }));
    expect(summarize(data).knownRequested).toBe(8);
    expect(summarize(data).requested).toBeNull();
    data.jobs = [];
    expect(summarize(data).knownRequested).toBe(0);
    expect(summarize(data).requested).toBe(0);
  });
});

describe('visible cluster capacity', () => {
  const node = (changes: Partial<ComputeNode>): ComputeNode => ({
    id: 'cluster-a:node1',
    source_id: 'one',
    cluster_id: 'cluster-a',
    name: 'node1',
    state: 'mixed',
    gpu_count: 8,
    gpu_allocated: 2,
    cpu_count: 64,
    cpu_allocated: 16,
    partitions: ['gpu'],
    observed_at: '2026-09-14T10:00:00Z',
    ...changes,
  });
  it('deduplicates by cluster and node name using the newest observation', () => {
    const nodes = [
      node({ gpu_allocated: 4, observed_at: '2026-09-14T10:02:00Z' }),
      node({ source_id: 'other-account' }),
      node({ name: 'node2', state: 'drained', gpu_count: 4, gpu_allocated: 1 }),
      node({ id: 'cluster-b:node1', cluster_id: 'cluster-b' }),
    ];
    expect(uniqueNodes(nodes)).toHaveLength(3);
    expect(summarizeNodes(nodes)).toMatchObject({
      nodes: 3,
      capacity: 20,
      allocated: 7,
      unallocated: 13,
      abnormal: 1,
      ratio: 35,
    });
  });
  it('counts INVAL nodes as abnormal and power-saving transitions as normal', () => {
    const nodes = [
      node({ name: 'bad', state: 'inval' }),
      node({ name: 'p1', state: 'idle+cloud+powering_down' }),
      node({ name: 'p2', state: 'idle+power_down' }),
      node({ name: 'p3', state: 'idle+powering_up' }),
      node({ name: 'p4', state: 'idle+cloud+powered_down' }),
    ];
    expect(summarizeNodes(nodes).abnormal).toBe(1);
  });
  it('leaves capacity and ratios unknown when nodes have missing allocation data', () => {
    expect(summarizeNodes([node({ gpu_allocated: null })])).toMatchObject({
      capacity: 8,
      allocated: null,
      unallocated: null,
      ratio: null,
      unknown: 1,
    });
    expect(summarizeNodes([])).toMatchObject({
      nodes: 0,
      capacity: null,
      allocated: null,
      unallocated: null,
      ratio: null,
    });
  });
});

describe('recorded GPU meaning', () => {
  it('keeps allocation and requests separate when the API only supplies a state-dependent count', () => {
    expect(jobGpuResources(job({}))).toEqual({ allocated: 4, requested: null });
    expect(jobGpuResources(job({ state: 'PENDING', gpu_count: 8 }))).toEqual({
      allocated: 0,
      requested: 8,
    });
    expect(jobGpuResources(job({ state: 'PENDING', gpu_count: null }))).toEqual({
      allocated: 0,
      requested: null,
    });
  });
  it('uses recorded known subtotals without filling old null history with zero', () => {
    const point: HistoryPoint = {
      at: '2026-09-14T10:00:00Z',
      allocated_gpus: null,
      gpu_utilization: null,
      coverage_count: 0,
    };
    expect(historyAllocation(point)).toBeNull();
    expect(historyAllocation({ ...point, allocated_gpus: 4 })).toBe(4);
    expect(
      historyAllocation({ ...point, known_allocated_gpus: 6, unknown_allocation_sources: 2 }),
    ).toBe(6);
    expect(historyAllocation({ ...point, known_allocated_gpus: 0 })).toBe(0);
    expect(
      historyAllocation({ ...point, allocated_gpus: 4, known_allocated_gpus: null }),
    ).toBeNull();
    expect(knownSum([4, undefined])).toBeNull();
  });
  it('marks a recorded subtotal that leaves sources out as partial', () => {
    const point: HistoryPoint = {
      at: '2026-09-14T10:00:00Z',
      allocated_gpus: 8,
      known_allocated_gpus: 8,
      unknown_allocation_sources: 0,
      gpu_utilization: null,
      coverage_count: 0,
    };
    expect(historyPartial(point)).toBe(false);
    expect(historyPartial({ ...point, allocated_gpus: null, unknown_allocation_sources: 1 })).toBe(
      true,
    );
    // Older samples recorded only the total, or nothing usable.
    expect(historyPartial({ ...point, known_allocated_gpus: undefined })).toBe(false);
    expect(historyPartial({ ...point, allocated_gpus: null, known_allocated_gpus: null })).toBe(
      false,
    );
  });
});

describe('job ordering', () => {
  it('parses Slurm elapsed formats', () => {
    expect(elapsedSeconds('42:18')).toBe(2538);
    expect(elapsedSeconds('12:42:18')).toBe(45738);
    expect(elapsedSeconds('1-06:12:04')).toBe(108724);
    expect(elapsedSeconds('INVALID')).toBe(0);
    expect(elapsedSeconds(null)).toBe(0);
  });

  it('lists running jobs first, then pending, longest-running first', () => {
    const ordered = sortJobs([
      job({ id: 'p', state: 'PENDING', elapsed: '0:00' }),
      job({ id: 'short', state: 'RUNNING', elapsed: '05:00' }),
      job({ id: 'f', state: 'FAILED', elapsed: '2-00:00:00' }),
      job({ id: 'long', state: 'COMPLETING', elapsed: '1-00:00:00' }),
      job({ id: 'boot', state: 'CONFIGURING', elapsed: '0:30' }),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['long', 'short', 'boot', 'p', 'f']);
  });
});

describe('current and partial resource readings', () => {
  it('keeps disabled and stale jobs out of current job tables', () => {
    const data = dashboard([
      job({}),
      job({ id: 'disabled', source_id: 'disabled' }),
      job({ id: 'stale', source_id: 'stale' }),
    ]);
    data.sources = [
      source({}),
      source({ id: 'disabled', enabled: false }),
      source({ id: 'stale', stale: true }),
    ];
    expect(currentJobs(data).map((item) => item.id)).toEqual(['cluster-a:42']);
  });
  it('lists the last-known jobs of a login that stopped collecting after the current ones', () => {
    const data = dashboard([
      job({ id: 'stale-only', source_id: 'stale' }),
      job({}),
      job({ id: 'disabled', source_id: 'disabled' }),
      // Seen by both logins: the current copy wins.
      job({ id: 'shared', source_id: 'stale', state: 'PENDING' }),
      job({ id: 'shared' }),
    ]);
    data.sources = [
      source({}),
      source({ id: 'disabled', enabled: false }),
      source({ id: 'stale', stale: true }),
    ];
    const { jobs, stale } = listedJobs(data);
    expect(jobs.map((item) => [item.id, item.source_id])).toEqual([
      ['cluster-a:42', 'one'],
      ['shared', 'one'],
      ['stale-only', 'stale'],
    ]);
    expect([...stale]).toEqual(['stale']);
    expect(jobsMissing(data.sources).map((item) => item.id)).toEqual(['stale']);
    expect(jobsMissing([source({ kind: 'cloud', status: 'error' })])).toEqual([]);
  });
  it('counts jobs exactly only while no login lacks a current job list', () => {
    expect(jobCount(3, 0)).toBe(3);
    expect(jobCount(0, 0)).toBe(0);
    expect(jobCount(3, 1)).toBe('≥ 3');
    expect(jobCount(0, 1)).toBe('—');
  });
  it('shows a known subtotal as a lower bound, not a complete total', () => {
    expect(partialCount(null, 4)).toBe('≥ 4');
    expect(partialCount(null, 0)).toBe('—');
    expect(partialCount(0, 0)).toBe(0);
    expect(partialCount(4, 4)).toBe(4);
    const summary = summarize(
      dashboard([
        job({ state: 'PENDING', gpu_count: 4 }),
        job({ id: 'unknown', state: 'PENDING', gpu_count: null }),
      ]),
    );
    expect(partialCount(summary.requested, summary.knownRequested)).toBe('≥ 4');
  });
  it('does not revive a failed snapshot merely because a retry is syncing', () => {
    const data = dashboard([job({})]);
    data.sources = [source({ status: 'syncing', error: 'connection failed' })];
    expect(summarize(data).knownAllocated).toBeNull();
    expect(currentJobs(data)).toEqual([]);
  });
});

describe('running price', () => {
  it('is not shown as the rate of a stopped or terminated instance', () => {
    expect(runningPrice(instance({ state: 'running', hourly_cost: 0.59 }))).toBe(0.59);
    expect(runningPrice(instance({ state: 'desired_running', hourly_cost: 0.59 }))).toBe(0.59);
    expect(runningPrice(instance({ state: 'unknown', hourly_cost: 0.59 }))).toBe(0.59);
    expect(runningPrice(instance({ state: 'desired_stopped', hourly_cost: 0.59 }))).toBeNull();
    expect(runningPrice(instance({ state: 'stopped', hourly_cost: 0.59 }))).toBeNull();
    expect(runningPrice(instance({ state: 'terminated', hourly_cost: 1 }))).toBeNull();
  });
});

describe('SSH process-based GPU use', () => {
  it.each([0, 1, null])(
    'reports %s occupied GPUs without replacing unknown with capacity',
    (gpu_allocated) => {
      const machine = instance({
        state: 'running',
        source_id: 'ssh-a',
        gpu_count: 8,
        gpu_allocated,
        metrics_scope: 'host_visible',
      });
      const data = {
        ...dashboard([]),
        sources: [
          source({ id: 'ssh-a', driver: 'ssh', kind: 'cloud', capabilities: ['instances'] }),
        ],
        instances: [machine],
      };
      const totals = summarize(data);
      expect(totals.allocated).toBe(gpu_allocated);
      expect(totals.unknownAllocationSources).toBe(gpu_allocated === null ? 1 : 0);
      expect(totals.knownAllocated).toBe(gpu_allocated ?? 0);
    },
  );
});
