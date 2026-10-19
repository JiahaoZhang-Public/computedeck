import { serverDashboard } from './test-server';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosticRows } from './ConnectionChecks';
import { sourceAttentionTone, sourceState } from './labels';
import { PlanPage } from './pages/Plan';
import { setLocale } from './i18n';
import { groupsOf } from './groups';
import type { Source, Dashboard } from './types';
import type { Ctx } from './pages/shared';

const source: Source = {
  id: 'a-alice',
  name: 'Example cluster',
  driver: 'slurm',
  kind: 'cluster',
  cluster_id: 'a',
  username: 'alice',
  ssh_alias: 'cluster-a',
  credential: '',
  enabled: true,
  status: 'ready',
  last_success: new Date().toISOString(),
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: ['jobs', 'nodes', 'qos_access', 'qos_limits'],
  qos: [],
};

describe('optional capabilities', () => {
  it('keeps missing history and inventory out of the anomaly count', () => {
    const partial = {
      ...source,
      warnings: [{ code: 'history_unavailable' }, { code: 'instances_unavailable' }],
    };
    expect(sourceAttentionTone(partial)).toBe('gray');
    expect(sourceState(partial)).toBe('ready');
    expect(sourceAttentionTone({ ...partial, stale: true })).toBe('amber');
    expect(sourceAttentionTone({ ...partial, error: { code: 'ssh_failed' } })).toBe('red');
  });
  it('renders the same failure and repair messages returned by doctor', () => {
    setLocale('en');
    const html = renderToStaticMarkup(
      <DiagnosticRows
        rows={[
          {
            id: 'ssh_alias',
            state: 'failed',
            label: { en: 'SSH alias resolves' },
            detail: { en: 'Check HostName.' },
          },
        ]}
      />,
    );
    expect(html).toContain('SSH alias resolves');
    expect(html).toContain('Check HostName.');
    expect(html).toContain('class="failed"');
  });
});

it('keeps unknown and unassociated QoS options in closed disclosures', () => {
  const data: Dashboard = serverDashboard({
    mode: 'live',
    sources: [
      {
        ...source,
        qos: [
          { name: 'allowed', access: 'verified', limits: {}, origin: 'test' },
          { name: 'unverified', access: 'unknown', limits: {}, origin: 'test' },
          { name: 'denied', access: 'not_associated', limits: {}, origin: 'test' },
        ],
      },
    ],
    jobs: [],
    instances: [],
    nodes: [],
    history: [],
    updated_at: null,
    refreshing: false,
  });
  const ctx = { data, groups: groupsOf(data), demo: false } as unknown as Ctx;
  const html = renderToStaticMarkup(<PlanPage ctx={ctx} />);
  const disclosures = [...html.matchAll(/<details[^>]*>(.*?)<\/details>/g)];
  expect(disclosures).toHaveLength(2);
  expect(disclosures.every((match) => !match[0].match(/<details[^>]*\sopen/))).toBe(true);
  expect(disclosures[0][1]).toContain('Unverified access (1)');
  expect(disclosures[1][1]).toContain('Not associated (1)');
  expect(html.slice(0, html.indexOf('<details'))).toContain('allowed');
});
