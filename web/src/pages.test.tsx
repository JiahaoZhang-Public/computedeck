import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupsOf } from './groups';
import { CloudPage } from './pages/Cloud';
import { InstanceDetail } from './pages/Details';
import { JobsPage } from './pages/Jobs';
import { OverviewPage } from './pages/Overview';
import type { Ctx } from './pages/shared';
import type { Dashboard, Instance, Job, Source } from './types';

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3600_000).toISOString();
const source = (extra: Partial<Source> = {}): Source => ({
  id: 'a-alice',
  name: 'A',
  driver: 'slurm',
  kind: 'cluster',
  cluster_id: 'a',
  username: 'alice',
  ssh_alias: 'a',
  credential: '',
  enabled: true,
  status: 'ready',
  last_success: now,
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: ['jobs', 'nodes'],
  qos: [],
  ...extra,
});
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id: `a:${id}`,
  source_id: 'a-alice',
  cluster_id: 'a',
  name: `train-${id}`,
  user: 'alice',
  account: '',
  partition: 'gpu',
  qos: 'normal',
  state: 'RUNNING',
  gpu_count: 1,
  gpu_type: 'a100',
  cpu_count: 1,
  node: 'g1',
  elapsed: '1:00',
  reason: null,
  gpu_utilization: null,
  cpu_utilization: null,
  memory_utilization: null,
  observed_at: hourAgo,
  ...extra,
});
const dash = (extra: Partial<Dashboard>): Dashboard => ({
  mode: 'live',
  sources: [source()],
  jobs: [],
  instances: [],
  nodes: [],
  history: [],
  updated_at: now,
  refreshing: false,
  ...extra,
});
const ctx = (data: Dashboard) =>
  ({
    data,
    groups: groupsOf(data),
    demo: false,
    group: 'all',
    query: '',
    attention: [],
    webPlugins: [],
    drivers: [],
    plugin: {},
    setGroup: () => {},
    openJob: () => {},
    configure: () => {},
  }) as unknown as Ctx;
/** "Label=count" for each job state tab. */
const tabs = (html: string) =>
  [...html.matchAll(/role="tab"[^>]*>([^<]*)<span>([^<]*)<\/span>/g)].map(
    (match) => `${match[1]}=${match[2]}`,
  );

// The only cluster login is failing (SSH timeout); its last snapshot still lists 3 jobs.
const failing = source({
  status: 'error',
  error: { code: 'ssh_timeout' },
  last_success: hourAgo,
  stale: true,
});

describe('jobs of a cluster whose collection is not current', () => {
  it('shows unknown counts, not 0, and lists the last-known jobs as stale', () => {
    const data = dash({
      sources: [failing],
      jobs: [job('1'), job('2'), job('3', { state: 'PENDING' })],
    });
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(data)} />);
    expect(tabs(html).slice(0, 3)).toEqual(['All=—', 'Running=—', 'Queued=—']);
    expect(html).not.toMatch(/No jobs/);
    expect(html.match(/class="clickable stale-row"/g)).toHaveLength(3);
    expect(html).toContain('last updated 1 h ago');
    expect(html).toContain('No current job list from A · alice; their jobs are unknown, not zero.');
    expect(html).toContain('Jobs tagged &quot;last updated&quot;');
  });

  it('says the jobs were not collected instead of "No jobs"', () => {
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(dash({ sources: [failing] }))} />);
    expect(html).not.toMatch(/No jobs/);
    expect(html).toContain('Jobs not collected');
    expect(html).toContain('No current job list from A · alice');
  });

  it('marks counts as lower bounds while another login is current', () => {
    const b = source({ id: 'b-bob', cluster_id: 'b', name: 'B', username: 'bob' });
    const data = dash({
      sources: [failing, b],
      jobs: [
        job('1'),
        job('b1', { id: 'b:1', source_id: 'b-bob', cluster_id: 'b' }),
        job('b2', { id: 'b:2', source_id: 'b-bob', cluster_id: 'b' }),
      ],
    });
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(data)} />);
    expect(tabs(html).slice(0, 3)).toEqual(['All=≥ 2', 'Running=≥ 2', 'Queued=—']);
    // The current jobs come first; the stale one last.
    expect(html.indexOf('train-b1')).toBeLessThan(html.indexOf('train-1'));
    expect(html.match(/stale-row/g)).toHaveLength(1);
  });

  it('keeps exact counts and plain rows while every login is current', () => {
    const html = renderToStaticMarkup(
      <JobsPage ctx={ctx(dash({ jobs: [job('1'), job('2', { state: 'PENDING' })] }))} />,
    );
    expect(tabs(html).slice(0, 3)).toEqual(['All=2', 'Running=1', 'Queued=1']);
    expect(html).not.toContain('stale-row');
    expect(html).not.toContain('No current job list');
  });

  it('does not tell a collected cluster without jobs to connect a cluster', () => {
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(dash({}))} />);
    expect(tabs(html).slice(0, 3)).toEqual(['All=0', 'Running=0', 'Queued=0']);
    expect(html).toContain('No jobs');
    expect(html).not.toContain('Connect a cluster');
  });

  it('leaves out the jobs of a disabled login', () => {
    const data = dash({
      sources: [source({ enabled: false, status: 'unconfigured', stale: true })],
      jobs: [job('1')],
    });
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(data)} />);
    expect(html).not.toContain('train-1');
    expect(html).toContain('Connect a cluster');
  });

  it('does not say "No running or queued jobs" on the overview', () => {
    const empty = renderToStaticMarkup(<OverviewPage ctx={ctx(dash({ sources: [failing] }))} />);
    expect(empty).not.toMatch(/No running or queued jobs/);
    expect(empty).toContain('Jobs not collected');
    const html = renderToStaticMarkup(
      <OverviewPage ctx={ctx(dash({ sources: [failing], jobs: [job('1')] }))} />,
    );
    expect(html).toMatch(/Current jobs<span class="count">—<\/span>/);
    expect(html).toContain('stale-row');
    expect(html).toContain('No current job list from A · alice');
  });
});

it('shows a fully unavailable cluster instead of an idle load bar', () => {
  const data = dash({
    sources: [source({ cluster_state: 'unavailable' })],
    nodes: Array.from({ length: 70 }, (_, i) => ({
      id: `a:${i}`,
      source_id: 'a-alice',
      cluster_id: 'a',
      name: `node-${i}`,
      state: 'down+not_responding',
      gpu_count: 8,
      gpu_allocated: 0,
      gpu_type: 'example',
      cpu_count: 32,
      cpu_allocated: 0,
      partitions: [],
      observed_at: now,
    })),
  });
  const html = renderToStaticMarkup(<OverviewPage ctx={ctx(data)} />);
  expect(html).toContain('70/70 nodes unavailable');
  expect(html).toContain('Unavailable');
});

describe('the last SSH check of a machine', () => {
  const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const machine: Instance = {
    id: 'manual:lab-box1',
    source_id: 'manual',
    platform: 'Lab workstation',
    name: 'dev-box',
    state: 'running',
    gpu_count: 2,
    gpu_allocated: 1,
    gpu_type: 'RTX 4090',
    gpu_utilization: 40,
    cpu_utilization: 10,
    memory_utilization: 20,
    host: '192.0.2.20',
    port: 22,
    username: 'alice',
    ssh_alias: 'cd-lab-workstation-box1',
    identity_file: null,
    hourly_cost: null,
    currency: 'USD',
    observed_at: twoMinutesAgo,
    ssh_status: 'reachable',
    last_probe_attempt: twoMinutesAgo,
    metrics_scope: 'host_visible',
    manual: true,
  };
  const drawer = (item: Instance) =>
    renderToStaticMarkup(
      <InstanceDetail
        item={item}
        ctx={ctx(dash({ instances: [item] }))}
        onProbe={async () => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );

  it('shows when it was checked and how many GPUs had processes', () => {
    const html = drawer(machine);
    expect(html).toContain('Reachable');
    expect(html).toContain('checked 2 min ago');
    expect(html).toMatch(/GPUs with processes<\/dt><dd>1</);
    const page = renderToStaticMarkup(
      <CloudPage ctx={ctx(dash({ sources: [], instances: [machine] }))} />,
    );
    expect(page).toContain('checked 2 min ago');
  });

  it('says why the GPUs in use are unknown instead of showing 0', () => {
    const html = drawer({
      ...machine,
      gpu_allocated: null,
      probe_warnings: [{ code: 'gpu_processes_unavailable', detail: 'rocm-smi' }],
    });
    expect(html).toMatch(/GPUs with processes<\/dt><dd>—/);
    expect(html).toContain('GPU processes unavailable: rocm-smi');
  });

  it('leaves the busy count out for a provider instance, which holds what it rents', () => {
    const html = drawer({ ...machine, manual: false, metrics_scope: undefined });
    expect(html).not.toContain('GPUs with processes');
  });
});
