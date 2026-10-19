import { setLocale, t } from './i18n';
import { ClustersPage } from './pages/Clusters';
import { PlanPage } from './pages/Plan';
import { UsagePage } from './pages/Usage';
import { serverDashboard, serverDemo } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupsOf } from './groups';
import { CloudPage } from './pages/Cloud';
import { InstanceDetail, JobDetail } from './pages/Details';
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
const dash = (extra: Partial<Dashboard>): Dashboard =>
  serverDashboard({
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
const ctx = (input: Dashboard) =>
  ({
    data: serverDashboard(input),
    groups: groupsOf(input),
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

function clusterData(states: string[], state: Source['cluster_state'] = 'available') {
  return dash({
    sources: [
      source({
        cluster_state: state,
        capabilities: ['jobs', 'nodes', 'qos_limits', 'qos_access'],
        qos: [
          {
            name: 'normal',
            access: 'verified',
            limits: { MaxTRESPU: 'gres/gpu=8' },
            origin: 'test',
          },
        ],
      }),
    ],
    nodes: states.map((state, i) => ({
      id: `a:${i}`,
      source_id: 'a-alice',
      cluster_id: 'a',
      name: `node-${i}`,
      state,
      gpu_count: 8,
      gpu_allocated: state === 'mixed' ? 2 : 0,
      gpu_type: 'example',
      cpu_count: 32,
      cpu_allocated: 0,
      partitions: [],
      observed_at: now,
    })),
  });
}

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

afterEach(() => setLocale('en'));
describe.each(['en', 'zh-CN'] as const)('server summary rendering in %s', (locale) => {
  it('names the unmeasured machine and uses singular wording for one excluded machine', () => {
    setLocale(locale);
    const data = serverDemo();
    const context = ctx(data);
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    expect(overview).toContain('≥ 21');
    expect(overview).toContain('build-box');
    expect(overview).toContain(t('msg.summary_not_probed_yet'));
    expect(overview).toContain(t('summary.unmonitored.one'));
    expect(t('summary.unmonitored', { count: 1 })).toBe(t('summary.unmonitored.one'));
    expect(t('summary.unmonitored', { count: 2 })).not.toBe(t('summary.unmonitored.one'));
    if (locale === 'en') expect(overview).not.toContain('1 machines');
  });
  it('shows the same all-down capacity on Overview, Clusters and Where to run', () => {
    setLocale(locale);
    const context = ctx(clusterData(Array(70).fill('down+not_responding'), 'unavailable'));
    const text = t('summary.capacity', { usable: 0, unavailable: 560 });
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    const plan = renderToStaticMarkup(<PlanPage ctx={context} />);
    for (const html of [overview, clusters, plan]) {
      expect(html).toContain(text);
      expect(html).not.toContain('0 / 560');
    }
    expect(overview).toContain(`<span class="red-text">${text}</span>`);
    expect(clusters).toContain(`<strong class="red-text">${text}</strong>`);
    expect(overview.split('</table>')[0]).not.toContain('meter-track');
    expect(clusters.split('</section>')[0]).not.toContain('meter-track');
    expect(plan).toContain(t('plan.verdict.unavailable'));
  });

  it.each(['error', 'stale'] as const)(
    'keeps the outage wording when another login is %s',
    (status) => {
      setLocale(locale);
      const data = clusterData(['down'], 'unavailable');
      data.sources.push(
        source({
          id: 'a-bob',
          username: 'bob',
          status,
          error: status === 'error' ? { code: 'ssh_timeout' } : null,
          stale: status === 'stale',
        }),
      );
      const context = ctx(data);
      for (const html of [
        renderToStaticMarkup(<OverviewPage ctx={context} />),
        renderToStaticMarkup(<ClustersPage ctx={context} />),
      ]) {
        expect(html).toContain(t('summary.capacity', { usable: 0, unavailable: 8 }));
        expect(html).not.toContain(t('summary.allocation', { allocated: 0, usable: 0 }));
      }
    },
  );

  it.each(['empty', 'failed', 'stale', 'unsupported'])(
    'uses a quiet placeholder for %s node data',
    (condition) => {
      setLocale(locale);
      const data = clusterData(condition === 'empty' ? [] : ['mixed']);
      if (condition === 'failed') data.sources[0].error = { code: 'ssh_timeout' };
      if (condition === 'stale') data.sources[0].stale = true;
      if (condition === 'unsupported') data.sources[0].capabilities = ['jobs'];
      const context = ctx(data);
      const overview = renderToStaticMarkup(<OverviewPage ctx={context} />).split('</table>')[0];
      const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />).split('</section>')[0];
      expect(context.data.summary.nodes.nodes).toBe(0);
      for (const html of [overview, clusters]) {
        expect(html).toContain('<span class="muted">—</span>');
        expect(html).not.toContain(t('summary.allocation', { allocated: '—', usable: '—' }));
        expect(html).not.toContain(t('summary.capacityTotal', { total: '—' }));
        expect(html).not.toContain('meter-track');
      }
    },
  );

  it.each(['FUTURE', 'ERROR'])('keeps the usable subtotal when a node is %s', (state) => {
    setLocale(locale);
    const context = ctx(clusterData(['mixed', state], 'unknown'));
    const text = t('summary.allocation', { allocated: '—', usable: '≥ 8' });
    for (const html of [
      renderToStaticMarkup(<OverviewPage ctx={context} />),
      renderToStaticMarkup(<ClustersPage ctx={context} />),
    ]) {
      expect(html).toContain(text);
      expect(html).toContain('≥ 8');
    }
  });

  it.each([
    ['available', ['mixed', 'mixed', 'mixed', 'drained'], '', 24, 6],
    ['degraded', ['mixed', ...Array(9).fill('drained')], 'amber-text', 8, 2],
  ] as const)(
    'shows allocation and the %s tone without escalating individual drained nodes',
    (state, states, tone, usable, allocated) => {
      setLocale(locale);
      const context = ctx(clusterData([...states], state));
      const text = t('summary.allocation', { allocated, usable });
      const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
      const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
      expect(overview).toContain(`<span class="${tone}">${text}</span>`);
      expect(clusters).toContain(`<strong class="${tone}">${text}</strong>`);
      const detail = t('summary.capacityDetail', {
        unavailable: states.length * 8 - usable,
        total: states.length * 8,
      });
      expect(overview).toContain(detail);
      expect(clusters).toContain(detail);
    },
  );

  it('shows allocation over usable GPUs without a zero-unavailable line for a healthy cluster', () => {
    setLocale(locale);
    const context = ctx(clusterData(['mixed', 'mixed']));
    for (const html of [
      renderToStaticMarkup(<OverviewPage ctx={context} />),
      renderToStaticMarkup(<ClustersPage ctx={context} />),
    ]) {
      expect(html).toContain(t('summary.allocation', { allocated: 4, usable: 16 }));
      expect(html).not.toContain(t('summary.capacityDetail', { unavailable: 0, total: 16 }));
    }
  });

  it('renders server figures without deriving them again from rows', () => {
    setLocale(locale);
    const context = ctx(serverDemo());
    context.data.summary.allocated = 123;
    context.data.summary.utilization = 87;
    context.data.summary.covered = 42;
    expect(renderToStaticMarkup(<OverviewPage ctx={context} />)).toContain('>123<');
    const usage = renderToStaticMarkup(<UsagePage ctx={context} />);
    expect(usage).toContain('>87<');
    expect(usage).toContain(t('usage.gpuHint', { count: 42 }));
  });
});

describe.each(['en', 'zh-CN'] as const)('scheduler field names in %s', (locale) => {
  it.each([
    ['slurm', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
    ['pbs', ['Account', 'Queue'], ['账户', '队列']],
    ['lsf', ['Project', 'Queue'], ['项目', '队列']],
    [
      'kubernetes',
      ['Namespace', 'Node pool', 'Priority class'],
      ['命名空间', '节点池', '优先级类'],
    ],
    ['plugin-scheduler', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
    ['', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
  ])(
    'uses the job source driver %s, with neutral labels for plugins and missing sources',
    (driver, en, zh) => {
      setLocale(locale);
      const queued = driver === 'pbs' || driver === 'lsf';
      const item = job('terms', {
        account: 'research',
        partition: 'gpu',
        qos: queued ? 'gpu' : 'normal',
      });
      // A different login comes first: lookup must use source_id, not the first cluster login.
      const data = dash({
        sources: [source({ id: 'other-login' }), ...(driver ? [source({ driver })] : [])],
      });
      const html = renderToStaticMarkup(<JobDetail job={item} ctx={ctx(data)} />);
      const fields = [...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map((match) => [
        match[1],
        match[2],
      ]);
      const names = locale === 'en' ? en : zh;
      expect(fields).toContainEqual([names[0], 'research']);
      expect(fields).toContainEqual([names[1], 'gpu']);
      if (queued) {
        expect(fields.filter(([, value]) => value === 'gpu')).toHaveLength(1);
        expect(html).not.toContain('<dt>QoS</dt>');
      } else expect(fields).toContainEqual([names[2], 'normal']);
      expect(html).not.toContain('Slurm Account');
    },
  );

  it('keeps missing scheduler field values unknown', () => {
    setLocale(locale);
    const html = renderToStaticMarkup(
      <JobDetail job={job('empty', { account: '', partition: '', qos: '' })} ctx={ctx(dash({}))} />,
    );
    for (const key of ['job.account', 'job.partition', 'job.qos'] as const)
      expect(html).toContain(`<dt>${t(key)}</dt><dd>—</dd>`);
  });

  it('names groups and mixed scheduler node pools without calling them sources', () => {
    setLocale(locale);
    const data = serverDemo();
    const context = ctx(data);
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    expect(overview).toContain(locale === 'en' ? 'Clusters &amp; clouds' : '集群与云平台');
    expect(overview).toContain(t('overview.col.source'));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    expect(clusters).toContain(`<th>${t('clusters.col.partition')}</th>`);
    expect(clusters).toContain(t('filter.byGroup'));
    expect(t('nav.cloud')).toBe(t('source.type.machines'));
  });
});
