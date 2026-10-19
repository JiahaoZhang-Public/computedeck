import { serverDashboard } from './test-server';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { PlanPage } from './pages/Plan';
import type { Ctx } from './pages/shared';
import type { Dashboard, Source } from './types';

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

function renderPlan(login: Source) {
  const data: Dashboard = serverDashboard({
    mode: 'live',
    sources: [login],
    jobs: [],
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
  const ctx = { data, groups: groupsOf(data), demo: false } as unknown as Ctx;
  return renderToStaticMarkup(<PlanPage ctx={ctx} />);
}

afterEach(() => setLocale('en'));

describe.each(['en', 'zh-CN'] as const)('planner explanations in %s', (locale) => {
  it('explains degradation without saying a known QoS limit is unknown', () => {
    setLocale(locale);
    const html = renderPlan({ ...source, cluster_state: 'degraded' });
    expect(html).toContain(t('plan.verdict.possible'));
    expect(html).toContain(t('plan.why.degraded'));
    expect(html).not.toContain(t('plan.why.possibleLimit', { free: 4 }));
  });

  it('explains unknown access separately from a known QoS limit', () => {
    setLocale(locale);
    const html = renderPlan({
      ...source,
      qos: [{ ...source.qos[0], access: 'unknown' }],
    });
    expect(html).toContain(t('plan.why.accessUnknown'));
    expect(html).not.toContain(t('plan.why.possibleLimit', { free: 4 }));
  });

  it('still explains when the QoS limit really is unknown', () => {
    setLocale(locale);
    const html = renderPlan({ ...source, qos: [{ ...source.qos[0], limits: {} }] });
    expect(html).toContain(t('plan.why.possibleLimit', { free: 4 }));
  });
});
