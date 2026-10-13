import { describe, expect, it } from 'vitest';
import { groupLabel, groupsOf, initials, instanceGroupKey } from './groups';
import { groupSummary, instanceCount } from './pages/summary';
import { nodeTone, sourceState } from './labels';
import type { Dashboard, Instance, Source } from './types';

const source = (extra: Partial<Source>): Source => ({
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
  last_success: null,
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: [],
  qos: [],
  ...extra,
});
const instance = (extra: Partial<Instance>): Instance => ({
  id: 'manual:lab-box',
  source_id: 'manual',
  platform: 'Lab workstation',
  name: 'box',
  state: 'unknown',
  gpu_count: 1,
  gpu_type: null,
  gpu_utilization: null,
  cpu_utilization: null,
  memory_utilization: null,
  host: '192.0.2.1',
  port: 22,
  username: 'alice',
  ssh_alias: 'cd-lab-box',
  identity_file: null,
  hourly_cost: null,
  currency: 'USD',
  observed_at: null,
  ssh_status: 'unverified',
  manual: true,
  ...extra,
});

describe('groups', () => {
  it('merges logins of one cluster and lists manual platforms after sources', () => {
    const sources = [
      source({}),
      source({ id: 'cluster-a-bob', username: 'bob' }),
      source({ id: 'pods', name: 'RunPod', driver: 'runpod', kind: 'cloud', cluster_id: 'runpod' }),
    ];
    const instances = [
      instance({}),
      instance({ id: 'runpod:x', source_id: 'pods', platform: 'RunPod', manual: false }),
    ];
    const groups = groupsOf({ sources, instances });
    expect(groups.map((group) => [group.key, group.kind, group.sources.length])).toEqual([
      ['cluster-a', 'cluster', 2],
      ['runpod', 'cloud', 1],
      ['platform:lab workstation', 'cloud', 0],
    ]);
    expect(groups.map((group) => group.color)).toEqual([0, 1, 2]);
    expect(instanceGroupKey(instances[1], sources)).toBe('runpod');
    expect(groupLabel(groups, 'cluster-a')).toBe('Cluster A');
    expect(groupLabel(groups, 'gone')).toBe('gone');
  });
  it('derives short marks from labels', () => {
    expect(initials('Cluster A')).toBe('CA');
    expect(initials('RunPod')).toBe('RU');
    expect(initials('lab-box')).toBe('LB');
    expect(initials('')).toBe('?');
  });
});

it('ignores a disabled stale login when reporting a healthy cluster', () => {
  const sources = [
    source({ last_success: '2026-10-12T12:00:00Z', capabilities: ['jobs'] }),
    source({ id: 'disabled', enabled: false, stale: true }),
  ];
  const data: Dashboard = {
    mode: 'live',
    sources,
    jobs: [],
    nodes: [],
    instances: [],
    history: [],
    updated_at: null,
    refreshing: false,
  };
  expect(sourceState(sources[1])).toBe('disabled');
  expect(groupSummary(data, groupsOf(data)[0]).state).toBe('ready');
});
it('shows a login disabled under an older version as disabled, not stale', () => {
  // Older versions kept the last success of a disabled login, so the service marks it stale.
  const old = source({
    enabled: false,
    status: 'unconfigured',
    last_success: '2026-01-01T00:00:00Z',
    stale: true,
  });
  expect(sourceState(old)).toBe('disabled');
  expect(sourceState({ ...old, status: 'error', error: 'ssh_failed' })).toBe('disabled');
  // A login that was never set up still reads as not connected.
  expect(sourceState(source({ enabled: false, status: 'unconfigured' }))).toBe('unconfigured');
  const data: Dashboard = {
    mode: 'live',
    sources: [old],
    jobs: [],
    nodes: [],
    instances: [],
    history: [],
    updated_at: null,
    refreshing: false,
  };
  expect(groupSummary(data, groupsOf(data)[0]).state).toBe('disabled');
});
it('distinguishes power-saving nodes from unavailable or reserved nodes', () => {
  expect(nodeTone('idle+cloud+powered_down')).toBe('green');
  expect(nodeTone('down+powered_down')).toBe('red');
  expect(nodeTone('idle+reserved')).toBe('red');
});
it.each(['idle+power_down', 'idle+cloud+powering_down', 'idle+power_up', 'idle+powering_up'])(
  'treats the Slurm power-saving transition %s as normal',
  (state) => {
    expect(nodeTone(state)).toBe('green');
  },
);
it('marks a Slurm INVAL node as abnormal', () => {
  expect(nodeTone('inval')).toBe('red');
  expect(nodeTone('idle+inval')).toBe('red');
  expect(nodeTone('down+powering_up')).toBe('red');
});

describe('instance counts', () => {
  const cloud = (extra: Partial<Source>) =>
    source({
      kind: 'cloud',
      last_success: new Date().toISOString(),
      capabilities: ['instances'],
      ...extra,
    });
  it('never shows an unread instance list as zero', () => {
    expect(instanceCount([cloud({})], 0)).toBe('0 instances');
    expect(instanceCount([cloud({ capabilities: ['account'] })], 0)).toBe('instances unknown');
    expect(instanceCount([cloud({ status: 'error' })], 2)).toBe('at least 2 instances');
    expect(instanceCount([cloud({ status: 'error' })], 1)).toBe('at least 1 instance');
  });
});
