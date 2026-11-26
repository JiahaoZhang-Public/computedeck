import { setLocale, t } from './i18n';
import { ClustersPage } from './pages/Clusters';
import { PlanPage } from './pages/Plan';
import { UsagePage } from './pages/Usage';
import { serverDashboard, serverDemo } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupsOf } from './groups';
import { CloudPage } from './pages/Cloud';
import { jobElapsed, jobReason } from './jobFacts';
import { eventJob } from './events';
import { relativeTime } from './domain';
import { ArrayDetail, InstanceDetail, JobDetail } from './pages/Details';
import { JobsPage } from './pages/Jobs';
import { OverviewPage } from './pages/Overview';
import type { Ctx } from './pages/shared';
import { FailuresTable, JobsTable } from './pages/shared';
import type { Dashboard, DeckEvent, Instance, Job, Source } from './types';

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
    tools: [],
    drivers: [],
    plugin: {},
    setGroup: () => {},
    openJob: () => {},
    configure: () => {},
  }) as unknown as Ctx;
/** The cluster card's hero figure: allocated over usable GPUs, in the card's tone. */
const hero = (allocated: number | string, usable: number | string, tone = '') =>
  `<strong class="cluster-hero ${tone}">${allocated} / ${usable}</strong>`;
/** The accessible name of the first cluster card's capacity bar, which holds its breakdown. */
const capacityBar = (html: string) =>
  html.match(/class="capacity-bar(?: unknown)?" role="img" aria-label="([^"]*)"/)?.[1] ?? '';
/** Markup without names and tooltips: what a sighted reader sees without hovering. */
const visible = (html: string) => html.replace(/\s(?:aria-label|title)="[^"]*"/g, '');
/** The Overview row's allocation meter text ("allocated / usable"). */
const meterText = (text: string) => `<span class="meter-text">${text}</span>`;
/** "Label=count" for each job state tab. */
const tabs = (html: string) =>
  [...html.matchAll(/role="tab"[^>]*>([^<]*)<span>([^<]*)<\/span>/g)].map(
    (match) => `${match[1]}=${match[2]}`,
  );
/** The Jobs page's result count ("≥ 36 jobs"), as read; "All" has no tab count of its own. */
const result = (html: string) =>
  /<span class="result-count">(.*?)<\/span>(?=<div class="toolbar-end"|<\/div>)/
    .exec(html)?.[1]
    .replace(/<[^>]+>/g, '');

function overviewGroupsTable(html: string) {
  const heading = `<h2>${t('overview.sources').replaceAll('&', '&amp;')}</h2>`;
  const start = html.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</table>', start);
  expect(end).toBeGreaterThan(start);
  const table = html.slice(start, end + '</table>'.length);
  expect(table).toContain('<tbody><tr');
  return table;
}

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
    expect(tabs(html).slice(0, 2)).toEqual(['Running=—', 'Queued=—']);
    expect(result(html)).toBe('— jobs');
    // The partial count is its own trigger, not a separate icon.
    expect(html).toMatch(
      /<span class="result-count"><button[^>]*class="partial"[^>]*><span>—<\/span><\/button>/,
    );
    expect(html).not.toMatch(/No jobs/);
    expect(html.match(/class="clickable stale-row"/g)).toHaveLength(3);
    expect(html).toContain('last updated 1 h ago');
    // One marker says the jobs are unknown; its list names the login (see quiet-markers.test).
    expect(html).toContain(t('jobs.missing.count', { count: 1 }));
    expect(html).toContain('aria-haspopup="dialog"');
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
    expect(tabs(html).slice(0, 2)).toEqual(['Running=≥ 2', 'Queued=—']);
    expect(result(html)).toBe('≥ 2 jobs');
    // The current jobs come first; the stale one last.
    expect(html.indexOf('train-b1')).toBeLessThan(html.indexOf('train-1'));
    expect(html.match(/stale-row/g)).toHaveLength(1);
  });

  it('keeps exact counts and plain rows while every login is current', () => {
    const html = renderToStaticMarkup(
      <JobsPage ctx={ctx(dash({ jobs: [job('1'), job('2', { state: 'PENDING' })] }))} />,
    );
    expect(tabs(html).slice(0, 2)).toEqual(['Running=1', 'Queued=1']);
    // An exact count is plain text.
    expect(result(html)).toBe('2 jobs');
    expect(html).not.toMatch(/<span class="result-count"><button/);
    expect(html).not.toContain('stale-row');
    expect(html).not.toContain('No current job list');
  });

  it('does not tell a collected cluster without jobs to connect a cluster', () => {
    const html = renderToStaticMarkup(<JobsPage ctx={ctx(dash({}))} />);
    expect(tabs(html).slice(0, 2)).toEqual(['Running=0', 'Queued=0']);
    expect(result(html)).toBe('0 jobs');
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
    // The panel's partial count is the trigger for whose jobs are missing.
    expect(html).toMatch(
      /Current jobs<span class="count"><button[^>]*class="partial"[^>]*><span>—<\/span><\/button><\/span>/,
    );
    expect(html).toContain('stale-row');
    expect(html).toContain(t('jobs.missing.count', { count: 1 }));
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
      partitions: ['gpu'],
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

  it('shows when it was checked and how many GPUs were in use', () => {
    const html = drawer(machine);
    expect(html).toContain('Reachable');
    expect(html).toContain('checked 2 min ago');
    expect(html).toMatch(/GPUs in use<\/dt><dd>1</);
    const page = renderToStaticMarkup(
      <CloudPage ctx={ctx(dash({ sources: [], instances: [machine] }))} />,
    );
    // The row keeps the status; when it was checked lives in the drawer.
    expect(page).toContain('Reachable');
    expect(page).not.toContain('checked 2 min ago');
  });

  it('says why the GPUs in use are unknown instead of showing 0', () => {
    const html = drawer({
      ...machine,
      gpu_allocated: null,
      probe_warnings: [{ code: 'gpu_processes_unavailable', detail: 'rocm-smi' }],
    });
    expect(html).toMatch(/GPUs in use<\/dt><dd>—/);
    expect(html).toContain('GPU processes unavailable: rocm-smi');
  });

  it('leaves the busy count out for a provider instance, which holds what it rents', () => {
    const html = drawer({ ...machine, manual: false, metrics_scope: undefined });
    expect(html).not.toContain('GPUs in use');
  });
});

afterEach(() => setLocale('en'));
describe.each(['en', 'zh-CN'] as const)('Overview order in %s', (locale) => {
  it('keeps the quiet attention line immediately before current jobs', () => {
    setLocale(locale);
    const html = renderToStaticMarkup(<OverviewPage ctx={ctx(dash({ jobs: [job('1')] }))} />);
    expect(html).toContain('id="attention"');
    // Nothing active: one sentence, no heading of its own, then the jobs panel.
    expect(html).toContain(
      `<section class="attention-quiet" id="attention" tabindex="-1"><p>${t('overview.attention.none')}</p></section><section class="panel "><header class="panel-header"><h2>${t('overview.jobs')}`,
    );
    expect(html).not.toContain(`<h2>${t('overview.attention')}`);
  });

  it.each([false, true])('puts current information before history (example mode: %s)', (demo) => {
    setLocale(locale);
    const data = serverDemo();
    const context = ctx(data);
    context.demo = demo;
    context.attention = data.attention ?? [];
    context.webPlugins = [
      { id: 'test-aside', overview: () => <aside data-testid="overview-aside" /> },
    ];
    const html = renderToStaticMarkup(<OverviewPage ctx={context} />);
    const headings = [...html.matchAll(/<h2>([^<]*)/g)].map((match) => match[1]);
    expect(headings).toEqual(
      [t('overview.attention'), t('overview.jobs'), t('activity.title'), t('overview.sources')].map(
        (heading) => heading.replaceAll('&', '&amp;'),
      ),
    );
    expect(html.startsWith('<div class="stats">')).toBe(true);
    expect(html).toMatch(/class="[^"]*\bjobs-table\b[^"]*"/);
    expect(html).toContain('id="attention"');
    expect(html.indexOf('id="attention"')).toBeLessThan(html.indexOf(`<h2>${t('overview.jobs')}`));
    const groups = overviewGroupsTable(html);
    expect(groups).toContain('<strong>Cluster A</strong>');
    expect(html.indexOf('class="table jobs-table"')).toBeLessThan(html.indexOf(groups));
    // Usage is one navigation item away; the page ends with its last table, not a link.
    expect(html).not.toContain('href="#/usage"');
    expect(html).not.toContain('class="trend-chart"');
    expect(html).toContain(`href="#/jobs">${t('overview.allJobs')}`);
    if (demo) {
      expect(html).not.toContain('data-testid="overview-aside"');
    } else {
      expect(html.indexOf('data-testid="overview-aside"')).toBeGreaterThan(html.indexOf(groups));
    }
  });
});

describe.each(['en', 'zh-CN'] as const)('server summary rendering in %s', (locale) => {
  it('shows a healthy resting cluster without an outage or double-counted GPUs', () => {
    setLocale(locale);
    const context = ctx(clusterData(['IDLE+CLOUD+POWERED_DOWN', 'IDLE+POWERING_UP']));
    // The capacity bar names on-demand GPUs apart from free and unavailable ones.
    const bar = renderToStaticMarkup(<ClustersPage ctx={context} />).match(
      /class="capacity-bar" role="img" aria-label="([^"]*)"/,
    )?.[1];
    expect(bar).toContain(t('summary.onDemand', { count: 16 }));
    expect(bar).toContain(t('clusters.bar.unavailable', { count: 0 }));
    // Overview shows the allocation only; the breakdown is on the cluster card and the plan.
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    expect(overview).not.toContain('16 unavailable · 16 total');
    expect(overview).not.toContain(t('plan.verdict.unavailable'));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    const plan = renderToStaticMarkup(<PlanPage ctx={context} />);
    expect(clusters).toContain(t('summary.onDemand', { count: 16 }));
    expect(plan).toContain(t('plan.why.onDemand', { count: 16 }));
    for (const html of [clusters, plan]) {
      expect(html).not.toContain('16 unavailable · 16 total');
      expect(html).not.toContain(t('plan.verdict.unavailable'));
    }
  });

  it('labels on-demand GPUs separately from free capacity', () => {
    setLocale(locale);
    const context = ctx(clusterData(['mixed', 'IDLE+CLOUD+POWERED_DOWN', 'FUTURE', 'ERROR']));
    expect(renderToStaticMarkup(<OverviewPage ctx={context} />)).not.toContain(
      t('summary.unknownNodes', { count: 2 }),
    );
    const clustersHtml = renderToStaticMarkup(<ClustersPage ctx={context} />);
    const plan = renderToStaticMarkup(<PlanPage ctx={context} />);
    expect(clustersHtml).toContain(t('summary.onDemand', { count: 8 }));
    expect(plan).toContain(t('plan.why.onDemand', { count: 8 }));
    for (const html of [clustersHtml, plan])
      expect(html).not.toContain(t('summary.unknownNodes', { count: 2 }));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    // The tag translates the node state; the scheduler's own word stays one hover away.
    expect(clusters).toContain(`title="IDLE+CLOUD+POWERED_DOWN">${t('clusters.onDemand')}</span>`);
    expect(clusters).toContain(hero(2, 8));
    // The bar's name counts allocated, free and on-demand GPUs apart.
    const bar = capacityBar(clusters);
    expect(bar).toContain(t('clusters.bar.allocated', { count: 2 }));
    expect(bar).toContain(t('clusters.bar.free', { count: 6 }));
    expect(bar).toContain(t('summary.onDemand', { count: 8 }));
  });

  it.each(['ALLOCATED+CLOUD+POWERING_UP', 'MIXED+POWER_DOWN'])(
    'keeps the working node %s labelled with its scheduler state',
    (state) => {
      setLocale(locale);
      const data = clusterData([state, 'mixed']);
      data.nodes[0].gpu_allocated = state.startsWith('ALLOCATED') ? 8 : 3;
      const context = ctx(data);
      const html = renderToStaticMarkup(<ClustersPage ctx={context} />);
      expect(html).not.toContain(t('clusters.onDemand'));
      expect(html).toContain(state.replaceAll('+', '+\u200b'));
      expect(html).toContain(hero(data.nodes[0].gpu_allocated! + 2, 16));
    },
  );

  it('labels FUTURE nodes neutrally while retaining their raw scheduler state', () => {
    setLocale(locale);
    const data = clusterData(['FUTURE']);
    const html = renderToStaticMarkup(<ClustersPage ctx={ctx(data)} />);
    // The raw scheduler state is the tag's tooltip, not a second line.
    expect(html).toContain(`<span class="tag gray" title="FUTURE">${t('clusters.future')}</span>`);
    expect(html).not.toContain('<small class="sub muted">');
  });

  it('explains why an idle Slurm node without a partition is unavailable', () => {
    setLocale(locale);
    const data = clusterData(['IDLE']);
    data.nodes[0].partitions = [];
    const html = renderToStaticMarkup(<ClustersPage ctx={ctx(data)} />);
    expect(html).toContain(`title="IDLE">${t('clusters.noPartition')}</span>`);
  });

  it('names the unmeasured machine and uses singular wording for one excluded machine', () => {
    setLocale(locale);
    const data = serverDemo();
    // Isolate the machine hint; the scenario also has missing cluster logins.
    const context = ctx(data);
    context.data.summary.unmeasured = context.data.summary.unmeasured.filter(
      (item) => item.subject.kind === 'instance',
    );
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    expect(overview).toContain('≥ 27');
    // One marker counts the unmeasured machine and the unmonitored one; its list names them.
    expect(overview).toContain(
      t('unmeasured.count', {
        count: context.data.summary.unmeasured.length + context.data.summary.unmonitored,
      }),
    );
    expect(overview).not.toContain(t('msg.summary_not_probed_yet'));
    expect(t('summary.unmonitored', { count: 1 })).toBe(t('summary.unmonitored.one'));
    expect(t('summary.unmonitored', { count: 2 })).not.toBe(t('summary.unmonitored.one'));
    if (locale === 'en') expect(overview).not.toContain('1 machines');
  });
  it('shows the same all-down capacity on Overview, Clusters and Where to run', () => {
    setLocale(locale);
    const context = ctx(clusterData(Array(70).fill('down+not_responding'), 'unavailable'));
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    const plan = renderToStaticMarkup(<PlanPage ctx={context} />);
    // No page reads the outage as 0 of 560 usable GPUs.
    for (const html of [overview, clusters, plan]) expect(html).not.toContain('0 / 560');
    // All three agree: no usable GPUs, in the outage tone; 560 are unavailable.
    const groups = overviewGroupsTable(overview);
    expect(groups).toContain('<strong>A</strong>');
    expect(groups).toContain(meterText('0 / 0'));
    expect(groups).toContain('<span class="status red">');
    expect(clusters).toContain(hero(0, 0, 'red-text'));
    expect(capacityBar(clusters)).toContain(t('clusters.bar.unavailable', { count: 560 }));
    expect(capacityBar(clusters)).toContain(t('clusters.bar.free', { count: 0 }));
    expect(clusters.split('</section>')[0]).not.toContain('meter-track');
    expect(plan).toContain(t('summary.capacity', { usable: 0, unavailable: 560 }));
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
      // The other login's state leads the status, but the outage still shows: no usable
      // GPUs on the row and the card, and the card's bar names the unavailable ones.
      const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
      const card = renderToStaticMarkup(<ClustersPage ctx={context} />).split('</section>')[0];
      expect(overview).toContain(meterText('0 / 0'));
      expect(card).toMatch(/<strong class="cluster-hero [^"]*">0 \/ 0<\/strong>/);
      expect(capacityBar(card)).toContain(t('clusters.bar.unavailable', { count: 8 }));
      for (const html of [overview, card]) expect(html).not.toContain('0 / 8');
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
      const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
      expect(overview).toContain('<strong>A</strong>');
      const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />).split('</section>')[0];
      expect(context.data.summary.nodes.nodes).toBe(0);
      // One dash in each place, not "— / —" and not an empty meter or bar.
      expect(overview).toContain(
        `<td data-label="${t('overview.col.capacity')}" class="no-value"><span class="muted">—</span></td>`,
      );
      expect(clusters).toMatch(/<strong class="cluster-hero [^"]*">—<\/strong>/);
      for (const html of [overview, clusters]) {
        expect(html).not.toContain('meter-track');
        expect(html).not.toContain('class="capacity-bar"');
      }
    },
  );

  it.each(['new_scheduler_state'])('keeps the usable subtotal when a node is %s', (state) => {
    setLocale(locale);
    const context = ctx(clusterData(['mixed', state], 'unknown'));
    const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    expect(overview).toContain(meterText('— / ≥ 8'));
    expect(clusters).toContain(hero('—', '≥ 8'));
    expect(capacityBar(clusters)).toContain(t('summary.unknownNodes', { count: 1 }));
  });

  it.each([
    ['available', ['mixed', 'mixed', 'mixed', 'drained'], '', 24, 6],
    ['degraded', ['mixed', ...Array(9).fill('drained')], 'amber-text', 8, 2],
  ] as const)(
    'shows allocation and the %s tone without escalating individual drained nodes',
    (state, states, tone, usable, allocated) => {
      setLocale(locale);
      const context = ctx(clusterData([...states], state));
      const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
      const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
      expect(overview).toContain(meterText(`${allocated} / ${usable}`));
      // Drained nodes lower the usable count; the cluster keeps its own tone, never red.
      expect(overview).toContain(`<span class="status ${tone ? 'amber' : 'green'}">`);
      expect(clusters).toContain(hero(allocated, usable, tone));
      const unavailable = t('clusters.bar.unavailable', { count: states.length * 8 - usable });
      // The unavailable breakdown is in the card's bar; the overview row stays one value per cell.
      expect(overview).not.toContain(unavailable);
      expect(capacityBar(clusters)).toContain(unavailable);
    },
  );

  it('shows allocation over usable GPUs without a zero-unavailable line for a healthy cluster', () => {
    setLocale(locale);
    const context = ctx(clusterData(['mixed', 'mixed']));
    const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    expect(overview).toContain(meterText('4 / 16'));
    expect(clusters).toContain(hero(4, 16));
    // "0 unavailable" may name the bar, but is never a visible line.
    const zero = t('clusters.bar.unavailable', { count: 0 });
    for (const html of [overview, clusters]) expect(visible(html)).not.toContain(zero);
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
    // How many GPUs the average covers is the figure's tooltip, never a caption.
    expect(usage).toContain(`title="${t('usage.gpuHint', { count: 42 })}">87<`);
    expect(visible(usage)).not.toContain(t('usage.gpuHint', { count: 42 }));
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
    ['constructor', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
    ['toString', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
    ['__proto__', ['Account', 'Partition', 'QoS'], ['账户', '分区', 'QoS']],
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

  it('names groups and the generic partition column without calling them sources', () => {
    setLocale(locale);
    const data = serverDemo();
    const context = ctx(data);
    const overview = renderToStaticMarkup(<OverviewPage ctx={context} />);
    expect(overview).toContain(locale === 'en' ? 'Clusters &amp; clouds' : '集群与云平台');
    expect(overview).toContain(t('overview.col.source'));
    const clusters = renderToStaticMarkup(<ClustersPage ctx={context} />);
    expect(clusters).toContain(`<th>${t('clusters.col.partition')}</th>`);
    expect(clusters).toContain(
      `<th>${locale === 'en' ? 'QoS / queue / quota' : 'QoS / 队列 / 配额'}</th>`,
    );
    const headers = [...clusters.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers.join(' ')).not.toMatch(/priority class|优先级类/i);
    expect(clusters).toContain(t('filter.byGroup'));
    expect(t('nav.cloud')).toBe(t('source.type.machines'));
  });

  it('explains scheduler-specific job fields in both table header tooltips', () => {
    setLocale(locale);
    const data = serverDemo();
    const groups = groupsOf(data);
    // The queue has its own column; its header's tooltip names each scheduler's term.
    const label = locale === 'en' ? 'Queue' : '队列';
    const hint =
      locale === 'en'
        ? 'Slurm QoS, PBS or LSF queue, Kubernetes priority class'
        : 'Slurm 的 QoS、PBS 或 LSF 的队列、Kubernetes 的优先级类';
    for (const table of [
      <JobsTable jobs={[job('terms')]} groups={groups} onOpen={() => {}} empty={null} />,
      <FailuresTable jobs={data.recent_failures ?? []} groups={groups} />,
    ]) {
      expect(renderToStaticMarkup(table)).toMatch(
        new RegExp(`<th class="(?:panel-hide )?col-low" title="${hint}">${label}</th>`),
      );
    }
  });
});

it.each(['en', 'zh-CN'] as const)(
  'explains partial capacity and all-down unknown totals in %s',
  (locale) => {
    setLocale(locale);
    const data = clusterData(['down', 'drained'], 'unavailable');
    data.nodes[1].gpu_count = null;
    const context = ctx(data);
    const overview = overviewGroupsTable(renderToStaticMarkup(<OverviewPage ctx={context} />));
    const card = renderToStaticMarkup(<ClustersPage ctx={context} />).split('</section>')[0];
    const plan = renderToStaticMarkup(<PlanPage ctx={context} />);
    // Where to run says the unavailable total is unknown rather than summing known nodes.
    expect(plan).toContain(t('summary.capacity', { usable: 0, unavailable: '—' }));
    // Overview and the card show no usable GPUs in the outage tone.
    expect(overview).toContain(meterText('0 / 0'));
    expect(overview).toContain('<span class="status red">');
    expect(card).toContain(hero(0, 0, 'red-text'));
    // Nowhere is the one known node's 8 GPUs passed off as the unavailable total.
    for (const html of [overview, card, plan])
      expect(html).not.toContain(t('clusters.bar.unavailable', { count: 8 }));
    // The card's bar is hatched as unknown and says the unavailable total is not known.
    expect(card).toContain('class="capacity-bar unknown"');
    expect(capacityBar(card)).toContain(t('clusters.bar.unavailable', { count: '—' }));
    const unknown = ctx(clusterData(['mixed', 'new_scheduler_state'], 'unknown'));
    // The card's bar names the unknown node; the overview row keeps its lower bound only.
    expect(capacityBar(renderToStaticMarkup(<ClustersPage ctx={unknown} />))).toContain(
      t('summary.unknownNodes', { count: 1 }),
    );
  },
);

it.each(['disabled', 'failed', 'stale', 'unsupported'])(
  'excludes retained %s nodes from the node panel',
  (condition) => {
    const data = clusterData(['idle']);
    if (condition === 'disabled') data.sources[0].enabled = false;
    if (condition === 'failed') data.sources[0].error = { code: 'ssh_timeout' };
    if (condition === 'stale') data.sources[0].stale = true;
    if (condition === 'unsupported') data.sources[0].capabilities = ['jobs'];
    const context = ctx(data);
    const html = renderToStaticMarkup(<ClustersPage ctx={context} />);
    // The heading carries no count; the empty list says there are no nodes.
    expect(html).toContain(`<h2>${t('clusters.nodes')}</h2>`);
    expect(html).toContain(t('clusters.nodes.none'));
    expect(html).not.toContain(`<td class="mono">${data.nodes[0].name}</td>`);
  },
);

it('names the missing login when current pending GPU counts are unknown and no jobs run', () => {
  const data = dash({
    sources: [source(), source({ id: 'a-bob', username: 'bob', stale: true })],
    jobs: [job('queued', { state: 'PENDING', gpu_count: null })],
  });
  const html = renderToStaticMarkup(<OverviewPage ctx={ctx(data)} />);
  const running = html
    .split(`<span class="stat-label">${t('overview.running')}</span>`)[1]
    .split('</div>')[0];
  expect(running).not.toContain('No clusters');
  // An unknown value, not a zero, that opens what it does not count: its list names A · bob
  // (see quiet-markers.test).
  expect(running).toContain(
    `class="partial" aria-label="—, ${t('unmeasured.count', { count: 1 })}"`,
  );
  expect(running).toContain('aria-haspopup="dialog"');
  expect(running).not.toMatch(/>0</);
});

it('counts hand-added machines by normalized manual group and names secondary cloud logins', async () => {
  const { SourcesPage } = await import('./pages/Sources');
  const data = serverDemo();
  data.instances = [
    data.instances[0],
    ...data.instances
      .slice(1, 3)
      .map((instance, index) => ({ ...instance, platform: index ? ' runpod ' : 'RunPod' })),
  ];
  const context = { ...ctx(data), nodes: [], serverName: t('where.local') };
  const html = renderToStaticMarkup(<SourcesPage ctx={context} />);
  const manual = html.split(t('sources.manual'))[1];
  expect(manual).toContain(t('overview.instances', { count: 2 }));
  expect(manual).not.toContain(t('overview.instances', { count: 3 }));
  expect(html).toContain('RunPod secondary');
});

describe.each(['en', 'zh-CN'] as const)('array summaries in %s', (locale) => {
  it.each(['slurm', 'pbs', 'lsf'])(
    'uses %s terms for shared drawer facts, including equal partition and QoS values',
    (driver) => {
      setLocale(locale);
      const jobs = [0, 1].map((index) =>
        job(String(index), { array_id: '1234', qos: 'long', partition: 'long' }),
      );
      const context = ctx(dash({ sources: [source({ driver })], jobs }));
      const html = renderToStaticMarkup(<ArrayDetail jobs={jobs} ctx={context} />);
      const labels = [...html.matchAll(/<dt>(.*?)<\/dt>/g)].map((match) => match[1]);
      expect(labels).toEqual([
        t('job.cluster'),
        t('job.user'),
        ...(driver === 'slurm' ? [t('job.qos'), t('job.partition')] : [t('job.queue')]),
      ]);
      expect(html.match(/<dd>long<\/dd>/g)).toHaveLength(driver === 'slurm' ? 2 : 1);
    },
  );

  it.each(['RUNNING', 'PENDING', 'SUSPENDED'])(
    'summarizes %s elements in one state cell and counts each state in the array pane',
    (state) => {
      setLocale(locale);
      const jobs = [0, 1].map((index) =>
        job(String(index), {
          array_id: '1234',
          state,
          reason: state === 'PENDING' ? 'Resources' : null,
        }),
      );
      const context = ctx(dash({ jobs }));
      const html = renderToStaticMarkup(<JobsPage ctx={context} />);
      const row = html.match(/<tr class="clickable array-row\b[^>]*>.*?<\/tr>/)?.[0] ?? '';
      expect(row).not.toBe('');
      // One summary in the row: how many, and how many run (or wait when nothing runs).
      const summary =
        state === 'PENDING'
          ? t('jobs.array.summaryQueued', { count: 2, pending: 2 })
          : state === 'RUNNING'
            ? t('jobs.array.summary', { count: 2, running: 2 })
            : // Nothing runs or waits: just how many, never "0 running".
              t('jobs.array.total', { count: 2 });
      expect(row.match(/<span class="array-states">(.*?)<\/span>/)?.[1]).toBe(summary);
      expect(row).not.toContain(t('jobs.array.other', { count: 2 }));
      // The reason cell is the short label of the pending reason, never the sentence.
      const reason = row.match(
        new RegExp(`data-label="${t('jobs.col.nodeReason')}"><span class="clamp">(.*?)</span>`),
      )?.[1];
      expect(reason).toBe(state === 'PENDING' ? t('job.short.resources') : '—');
      expect(row).not.toContain(t('job.explain.resources'));
      // The array pane still counts every state.
      const pane = renderToStaticMarkup(<ArrayDetail jobs={jobs} ctx={context} />);
      expect(pane).toContain(
        `<p>${[
          t('jobs.array.running', { count: state === 'RUNNING' ? 2 : 0 }),
          t('jobs.array.pending', { count: state === 'PENDING' ? 2 : 0 }),
          t('jobs.array.other', { count: state === 'SUSPENDED' ? 2 : 0 }),
        ].join(t('common.listSeparator'))}</p>`,
      );
    },
  );

  it('groups after search, counts elements in chips, and translates summaries', () => {
    setLocale(locale);
    const elements = Array.from({ length: 3 }, (_, index) =>
      job(String(index), {
        array_id: '1234',
        array_index: String(index),
        name: index < 2 ? 'selected' : 'excluded',
        state: index === 2 ? 'PENDING' : 'RUNNING',
        gpu_count: index === 0 ? null : 2,
        qos: index === 0 ? 'normal' : 'long',
      }),
    );
    const data = dash({ jobs: elements });
    const context = ctx(data);
    // The row summarizes its elements in one cell: how many, and how many run.
    const states = (count: number, running: number) =>
      `<span class="array-states">${t('jobs.array.summary', { count, running })}</span>`;
    const all = states(3, 2);
    let html = renderToStaticMarkup(<JobsPage ctx={context} />);
    expect(result(html)).toBe(t('jobs.resultCount', { count: 3 }));
    expect(tabs(html)).toContain(`${t('status.RUNNING')}=2`);
    expect(html.match(/class="clickable array-row/g)).toHaveLength(1);
    expect(html).toContain(all);
    expect(html).toContain(t('jobs.array.mixed'));
    expect(html).toContain('≥ 2');
    expect(html).toContain(t('jobs.array.unknownGpus', { count: 1 }));
    context.query = '1234'; // Matches array_id even though the element ids differ.
    html = renderToStaticMarkup(<JobsPage ctx={context} />);
    expect(html).toContain(all);
    context.query = 'selected';
    html = renderToStaticMarkup(<JobsPage ctx={context} />);
    expect(html).toContain(states(2, 2));
    expect(html).not.toContain('excluded');
    expect(result(html)).toBe(t('jobs.resultCount', { count: 2 }));
    context.query = 'excluded';
    html = renderToStaticMarkup(<JobsPage ctx={context} />);
    expect(html).not.toContain('array-row');
    expect(html).toContain('a:2');
  });

  it('shows unknown fields honestly and keeps the partition in the array drawer', () => {
    setLocale(locale);
    const cases = [
      { id: '1234', qos: null, partitions: [null, null] },
      { id: '1235', qos: 'long', partitions: ['long', 'long'] },
      { id: '1236', qos: 'long', partitions: ['gpu', 'gpu'] },
      { id: '1237', qos: 'long', partitions: ['long', 'gpu'] },
      { id: '1238', qos: 'long', partitions: [null, null] },
    ];
    const data = dash({
      jobs: cases.flatMap(({ id, qos, partitions }) =>
        partitions.map((partition, index) =>
          job(`${id}_${index}`, {
            array_id: id,
            array_index: String(index),
            qos,
            partition,
          }),
        ),
      ),
    });
    const context = ctx(data);
    const html = renderToStaticMarkup(<JobsPage ctx={context} />);
    const rows = [...html.matchAll(/<tr class="clickable array-row\b[^>]*>.*?<\/tr>/g)].map(
      (match) => match[0],
    );
    expect(rows).toHaveLength(cases.length);
    const row = (id: string) => {
      // Match the exact array label in the name's tooltip, regardless of the row ordering.
      const matches = rows.filter((html) => html.includes(` [${id}]"`));
      expect(matches).toHaveLength(1);
      for (const other of cases.filter((item) => item.id !== id))
        expect(matches[0]).not.toContain(` [${other.id}]"`);
      return matches[0];
    };
    // The row names the queue once, in its column; an unknown one stays a dash, never a guess.
    const queue = (html: string) =>
      html.match(
        new RegExp(`<td class="panel-hide col-low" data-label="${t('job.queue')}">(.*?)</td>`),
      )?.[1];
    expect(queue(row('1234'))).toBe('—');
    for (const id of ['1235', '1236', '1237', '1238']) expect(queue(row(id))).toBe('long');
    for (const id of ['1234', '1238']) expect(row(id)).not.toContain(t('jobs.array.mixed'));
    // The partition moved out of the row; the array drawer still states it, mixed or unknown.
    const partition = (id: string) => {
      const jobs = data.jobs.filter((item) => item.array_id === id);
      const drawer = renderToStaticMarkup(<ArrayDetail jobs={jobs} ctx={context} />);
      const at = drawer.indexOf(`<dt>${t('job.partition')}</dt><dd>`);
      expect(at).toBeGreaterThan(-1);
      return drawer.slice(at).match(/<dd>(.*?)<\/dd>/)?.[1];
    };
    expect(partition('1234')).toBe('—');
    expect(partition('1235')).toBe('long');
    expect(partition('1236')).toBe('gpu');
    expect(partition('1237')).toBe(t('jobs.array.mixed'));
    expect(partition('1238')).toBe('—');
  });

  it('takes eight rows after grouping and tags an array with any stale element', () => {
    setLocale(locale);
    const elements = Array.from({ length: 12 }, (_, index) =>
      job(`1234_${index}`, {
        array_id: '1234',
        array_index: String(index),
        elapsed: '2:00:00',
        source_id: index === 11 ? 'a-bob' : 'a-alice',
      }),
    );
    const data = dash({
      jobs: [...elements, ...Array.from({ length: 9 }, (_, index) => job(`ordinary-${index}`))],
      sources: [source(), source({ id: 'a-bob', username: 'bob', stale: true })],
    });
    const html = renderToStaticMarkup(<OverviewPage ctx={ctx(data)} />);
    const table = html.slice(
      html.indexOf('class="table jobs-table'),
      html.indexOf('</table>', html.indexOf('class="table jobs-table')),
    );
    expect(table.match(/class="clickable/g)).toHaveLength(8);
    expect(table).toContain('array-row stale-row');
    expect(table).toContain(
      `<span class="array-states">${t('jobs.array.summary', { count: 12, running: 12 })}</span>`,
    );
    expect(table).toContain('a:ordinary-6');
    expect(table).not.toContain('a:ordinary-7');
    // The uncounted last-known job is listed behind the marker (see quiet-markers.test).
    expect(html).toContain(t('jobs.missing.count', { count: 1 }));
  });
});

it.each(['en', 'zh-CN'] as const)(
  'shows failure facts, known limits and log paths without live meters in %s',
  (locale) => {
    setLocale(locale);
    const item = job('failed', {
      state: 'FAILED',
      end: null,
      exit_code: '0:9',
      exit_status: 0,
      exit_signal: 9,
      elapsed: '01:00:00',
      time_limit: '02:00:00',
      log_path: '/work/train.log',
      gpu_utilization: 80,
    });
    const data = dash({ failure_history_observed_at: hourAgo });
    const html = renderToStaticMarkup(<JobDetail job={item} ctx={ctx(data)} />);
    expect(html).toContain(t('failure.sigkill'));
    expect(html).toContain(t('failure.signalEvidence', { signal: 9 }));
    // The scheduler's 01:00:00 reads like every other duration.
    expect(html).toContain(
      t('failure.ranLimit', { elapsed: jobElapsed('01:00:00'), limit: jobElapsed('02:00:00') }),
    );
    expect(html).toContain('/work/train.log');
    expect(html).toContain(t('failure.historyUpdated'));
    expect(html).toContain(t('failure.copyInspection'));
    expect(html).not.toContain('drawer-metrics');
    for (const key of ['job.submitted', 'job.started', 'job.waiting', 'common.sampledAt'] as const)
      expect(html).not.toContain(`<dt>${t(key)}</dt>`);
    const reported = renderToStaticMarkup(
      <JobDetail
        job={{ ...item, state: 'OUT_OF_MEMORY', reason: 'TERM_MEMLIMIT: raw scheduler detail' }}
        ctx={ctx(data)}
      />,
    );
    // What the scheduler reported leads; its raw code is the chip beside the state in the
    // drawer header (app/Layers.tsx), so the body carries no "Scheduler reason:" label.
    const summary = t('failure.reported', { scheduler: 'Slurm', cause: t('failure.memory') });
    expect(reported).toContain(`<p class="lead">${summary}</p>`);
    expect(reported).not.toContain(locale === 'en' ? 'Scheduler reason:' : '调度器原因：');
    expect(reported).not.toContain('SIGKILL');
  },
);

it.each(['en', 'zh-CN'] as const)(
  'explains raw pending states only for live jobs in %s',
  (locale) => {
    setLocale(locale);
    const context = ctx(dash({}));
    for (const state of ['PENDING', 'PD', 'Q', 'PEND', 'QUEUED', 'queued']) {
      const item = job('waiting', { state, reason: 'Priority' });
      const explanation = jobReason(item, 'slurm')!;
      const html = renderToStaticMarkup(<JobDetail job={item} ctx={context} />);
      // No heading: the summary leads the callout and the next step follows as plain text.
      expect(html).toContain(`<div class="callout"><p class="lead">${explanation.summary}</p>`);
      expect(html).toContain(`<p>${explanation.next}</p>`);
      expect(html).not.toContain('<strong>Pending reason</strong>');
      expect(html).toContain(`<dt>${t('job.requestedGpus')}</dt>`);
      const historical = renderToStaticMarkup(
        <JobDetail job={{ ...item, end: hourAgo }} ctx={context} />,
      );
      expect(historical).not.toContain(explanation.summary);
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'labels a queued row by its short reason and keeps the sentence in the job pane in %s',
  (locale) => {
    setLocale(locale);
    const escape = (text: string) =>
      text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#x27;');
    // Known kinds use their label; an unknown code is shown as the scheduler wrote it, without
    // its detail; no reason at all reads "Waiting".
    const cases: [string | null, string][] = [
      ['Resources', t('job.short.resources')],
      ['QOSMaxGRESPerUser', t('job.short.personalLimit')],
      ['QOSMaxGRESPerJob', t('job.short.requestLimit')],
      ['JobHeldUser', t('job.short.hold')],
      ['ReqNodeNotAvail, UnavailableNodes:g[1-2]', t('job.short.nodes')],
      ['SiteCustomHold (site detail)', 'SiteCustomHold'],
      [null, t('job.short.waiting')],
    ];
    const jobs = cases.map(([reason], index) =>
      job(`queued-${index}`, { state: 'PENDING', node: null, reason }),
    );
    const context = ctx(dash({ jobs }));
    const html = renderToStaticMarkup(
      <JobsTable jobs={jobs} groups={context.groups} onOpen={() => {}} empty={null} />,
    );
    const cell = `data-label="${t('jobs.col.nodeReason')}"><span class="clamp">(.*?)</span>`;
    const cells = [...html.matchAll(new RegExp(cell, 'g'))].map((match) => match[1]);
    expect(cells).toEqual(cases.map(([, label]) => escape(label)));
    // No tooltip, raw detail or sentence in the row.
    expect(html).not.toContain('<span class="clamp" title=');
    expect(html).not.toContain('UnavailableNodes');
    expect(html).not.toContain('site detail');
    for (const item of jobs) {
      const explanation = jobReason(item, 'slurm')!;
      expect(html).not.toContain(escape(explanation.summary));
      // The pane leads with the sentence and ends with the next step.
      const pane = renderToStaticMarkup(<JobDetail job={item} ctx={context} />);
      expect(pane).toContain(`<p class="lead">${escape(explanation.summary)}</p>`);
      expect(pane).toContain(`<p>${escape(explanation.next)}</p>`);
    }
    expect(jobReason(jobs[5], 'slurm')!.summary).toBe(t('job.explain.unknown'));
    expect(jobReason(jobs[6], 'slurm')!.summary).toBe(t('job.explain.unknown'));
    // Schedulers' short queued states get the same label as PENDING.
    const short = [job('pd', { state: 'PD', node: null, reason: 'Priority' })];
    const pd = renderToStaticMarkup(
      <JobsTable jobs={short} groups={context.groups} onOpen={() => {}} empty={null} />,
    );
    expect([...pd.matchAll(new RegExp(cell, 'g'))].map((match) => match[1])).toEqual([
      escape(t('job.short.priority')),
    ]);
  },
);

it.each(['en', 'zh-CN'] as const)(
  'shows uninterpreted exit codes once and omits missing codes in %s',
  (locale) => {
    setLocale(locale);
    for (const code of ['unknown-code', null]) {
      const html = renderToStaticMarkup(
        <JobDetail
          job={job('failure', { state: 'FAILED', exit_code: code })}
          ctx={ctx(dash({}))}
        />,
      );
      expect(html.split(`<dt>${t('jobs.col.exitCode')}</dt>`).length - 1).toBe(
        code == null ? 0 : 1,
      );
      if (code != null) expect(html.split(code).length - 1).toBe(1);
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'keeps failure next steps and omits missing elapsed time in %s',
  (locale) => {
    setLocale(locale);
    const context = ctx(dash({}));
    for (const state of [
      'OUT_OF_MEMORY',
      'TIMEOUT',
      'DEADLINE',
      'NODE_FAIL',
      'BOOT_FAIL',
      'PREEMPTED',
      'FAILED',
    ]) {
      const item = job('failure', { state, end: null, exit_code: '1:0', elapsed: '' });
      const html = renderToStaticMarkup(<JobDetail job={item} ctx={context} />);
      // The next step stays in the failure callout, without "What happened" / "Next step" headings.
      const start = html.indexOf('<div class="callout red failure-explanation">');
      expect(start).toBeGreaterThan(-1);
      expect(html.slice(start, html.indexOf('</div>', start))).toContain(
        `<p>${jobReason(item, 'slurm')!.next}</p>`,
      );
      expect(html).not.toContain('What happened');
      expect(html).not.toContain('Next step');
      const table = renderToStaticMarkup(
        <FailuresTable jobs={[{ ...item, end: null, exit_code: '1:0' }]} groups={context.groups} />,
      );
      expect(table).not.toContain('ran —');
    }
    for (const state of ['COMPLETED', 'CANCELLED', 'UNKNOWN']) {
      const ended = job('ended', { state, end: hourAgo });
      const html = renderToStaticMarkup(<JobDetail job={ended} ctx={context} />);
      expect(html).not.toContain('failure-explanation');
      const next = jobReason(ended, 'slurm')?.next;
      if (next) expect(html).not.toContain(next);
    }
  },
);

it.each(['en', 'zh-CN'] as const)(
  'explains unknown outcomes in full sentences and only offers useful inspection in %s',
  (locale) => {
    setLocale(locale);
    for (const reason of ['outcomes_unavailable', 'outcome_not_reported'] as const) {
      const event: DeckEvent = {
        id: 1,
        type: 'job.finished',
        at: hourAgo,
        source_id: 'a-alice',
        data: {
          driver: 'slurm',
          outcome: 'unknown',
          outcome_reason: reason,
          observed_at: now,
          job: job('ended'),
        },
      };
      const html = renderToStaticMarkup(
        <JobDetail job={eventJob(event)!} event={event} ctx={ctx(dash({}))} />,
      );
      expect(html).toContain(
        t(
          reason === 'outcomes_unavailable'
            ? 'event.unknownUnavailable'
            : 'event.unknownNotReported',
        ),
      );
      expect(html.includes(t('failure.copyInspection'))).toBe(reason !== 'outcomes_unavailable');
      expect(html.includes('sacct -j')).toBe(reason !== 'outcomes_unavailable');
      expect(html).not.toContain('Next step');
      expect(html).toContain(t('event.lastSeenEnded', { time: relativeTime(hourAgo) }));
      expect(html).toContain(`<dt>${t('event.observedAt')}</dt>`);
      expect(html).toContain(`>${relativeTime(now)}</dd>`);
    }
  },
);
