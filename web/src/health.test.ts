import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeHealth } from './health';
import { groupsOf, sourceLabel } from './groups';
import { groupSummary } from './pages/summary';
import { serverDemo } from './test-server';
import { setLocale, t } from './i18n';
import type { Health } from './types';

const health: Health = {
  status: 'ok',
  started_at: '',
  database_path: '',
  polling: true,
  ssh_installed: true,
  source_count: 4,
};
afterEach(() => {
  setLocale('en');
  vi.useRealTimers();
});

// These unit tests isolate health precedence from the demo's deliberate source faults.
function healthyDashboard() {
  const data = serverDemo();
  data.sources = data.sources.filter((source) => !source.error && !source.stale);
  data.behind = [];
  data.as_of = data.sources.map((source) => source.last_success!).sort()[0];
  return data;
}

describe.each(['en', 'zh-CN'] as const)('freshness in %s', (locale) => {
  it('uses server age and stale flags, excludes disabled failures, and keeps age while collecting', () => {
    setLocale(locale);
    const data = healthyDashboard();
    data.sources[0].enabled = false;
    data.sources[0].error = 'offline';
    data.as_of = new Date(Date.now() - 8 * 60000).toISOString();
    const state = computeHealth(data, health, null, false, false);
    expect(state.level).toBe('ok');
    expect(state.age).toBe(t('time.minutesAgo', { count: 8 }));
    expect(state.rows.some((row) => row.collecting)).toBe(true);
    data.sources[1].stale = true;
    data.behind = [data.sources[1].id];
    expect(computeHealth(data, health, null, false, false).level).toBe('warn');
    data.sources[1].error = 'offline';
    expect(computeHealth(data, health, null, false, false).level).toBe('bad');
  });

  it('keeps first load, token gate, no sources and missing success honest', () => {
    setLocale(locale);
    expect(computeHealth(null, null, null, false, false).level).toBe('unknown');
    const data = healthyDashboard();
    expect(computeHealth(data, health, 'unauthorized', true, false).level).toBe('unknown');
    expect(computeHealth(data, health, 'unauthorized', true, false).rows).toEqual([]);
    data.sources[0].last_success = null;
    data.as_of = null;
    expect(computeHealth(data, health, null, false, false).age).toBe(t('health.notCollected'));
    data.sources = [];
    expect(computeHealth(data, health, null, false, false).level).toBe('unknown');
  });

  it.each([1, 2])(
    'names a single failing or stale source and counts multiple sources (%s)',
    (count) => {
      setLocale(locale);
      const data = healthyDashboard();
      data.sources = data.sources.slice(0, 2);
      for (const source of data.sources.slice(0, count)) source.stale = true;
      const name = sourceLabel(groupsOf(data), data.sources[0]);
      expect(computeHealth(data, health, null, false, false).label).toBe(
        count === 1 ? t('health.sourceStale', { name }) : t('health.stale', { count }),
      );
      for (const source of data.sources.slice(0, count)) source.error = 'offline';
      expect(computeHealth(data, health, null, false, false).label).toBe(
        count === 1 ? t('health.sourceFailing', { name }) : t('health.failing', { count }),
      );
    },
  );

  it.each([1, 2])('uses singular and plural labels (%s)', (count) => {
    setLocale(locale);
    const expected =
      locale === 'en'
        ? {
            fresh: ['1 source fresh', 'All 2 fresh'],
            stale: ['1 source stale', '2 sources stale'],
            behind: ['1 source behind', '2 sources behind'],
            backoff: ['backing off after 1 failure', 'backing off after 2 failures'],
            unreadable: ['1 stored row could not be read', '2 stored rows could not be read'],
          }
        : {
            fresh: ['1 个来源数据有效', '全部 2 个来源数据有效'],
            stale: ['1 个来源数据已过期', '2 个来源数据已过期'],
            behind: ['1 个来源未更新', '2 个来源未更新'],
            backoff: ['已失败 1 次，延后重试', '已失败 2 次，延后重试'],
            unreadable: ['无法读取 1 条存储记录', '无法读取 2 条存储记录'],
          };
    for (const key of ['fresh', 'stale', 'behind', 'backoff', 'unreadable'] as const) {
      expect(t(`health.${key}`, { count })).toBe(expected[key][count - 1]);
    }
    const data = healthyDashboard();
    data.sources = data.sources.slice(0, count);
    expect(computeHealth(data, health, null, false, false).label).toBe(expected.fresh[count - 1]);
    data.behind = data.sources.map((source) => source.id);
    expect(computeHealth(data, health, null, false, false).label).toBe(expected.behind[count - 1]);
    const broken = { ...health, unreadable_rows: { snapshots: count } };
    expect(computeHealth(data, broken, null, false, false).label).toBe(
      expected.unreadable[count - 1],
    );
  });

  it('distinguishes no enabled sources from first load and the token gate', () => {
    setLocale(locale);
    const data = healthyDashboard();
    data.as_of = null;
    data.behind = [];
    for (const sources of [[], data.sources.map((source) => ({ ...source, enabled: false }))]) {
      data.sources = sources;
      const state = computeHealth(data, { ...health, polling: false }, null, false, false);
      expect(state.level).toBe('unknown');
      expect(state.label).toBe(t('health.noSourcesConnected'));
      expect(state.age).toBe(state.label);
      expect(computeHealth(data, health, null, true, false).label).toBe(t('health.unknown'));
    }
    expect(computeHealth(null, null, null, false, false).label).toBe(t('health.unknown'));
  });

  it('ignores loop errors from disabled or removed plugins', () => {
    setLocale(locale);
    const data = healthyDashboard();
    const broken = {
      ...health,
      plugins: { notify: { enabled: false } },
      background_errors: { 'notify:events': { at: '', error: 'delivery failed' } },
    };
    expect(computeHealth(data, broken, null, false, false).faults).toEqual([]);
    expect(computeHealth(data, { ...broken, plugins: {} }, null, false, false).level).toBe('ok');
    data.sources[0].error = 'offline';
    expect(computeHealth(data, broken, null, false, false).label).toBe(
      t('health.sourceFailing', { name: sourceLabel(groupsOf(data), data.sources[0]) }),
    );
  });

  it('reports collection-machine failures', () => {
    setLocale(locale);
    const state = computeHealth(serverDemo(), health, null, false, false, [
      {
        id: 'relay-a',
        name: 'Relay A',
        ssh_alias: 'relay-a',
        command: 'computedeck',
        status: 'error',
        version: null,
        drivers: [],
        checked_at: null,
        error: { code: 'ssh_failed', detail: 'SSH failed' },
      },
    ]);
    expect(state.level).toBe('bad');
    expect(state.label).toBe(t('health.nodeFault', { name: 'Relay A' }));
    expect(state.faults[0].page).toBe('sources');
  });

  it('takes the worst service state and isolates example sources from live service faults', () => {
    setLocale(locale);
    const data = healthyDashboard();
    const broken = {
      ...health,
      polling: false,
      background_errors: {
        'collector:schedule': { at: '2026-10-13T12:00:00Z', error: 'bad schedule' },
      },
      unreadable_rows: { snapshots: 2 },
    };
    const state = computeHealth(data, broken, null, false, false);
    expect(state.level).toBe('bad');
    expect(state.collectorFault).toBe(true);
    expect(state.faults.map((fault) => fault.title)).toEqual([
      t('health.collectorFault'),
      t('health.unreadable', { count: 2 }),
    ]);
    expect(computeHealth(data, { ...health, polling: false }, null, false, false).label).toBe(
      t('health.pollingOff'),
    );
    expect(computeHealth(data, broken, 'offline', false, false).label).toBe(
      t('health.unreachable'),
    );
    const demo = computeHealth(data, broken, null, false, true);
    expect(demo.level).toBe('ok');
    expect(demo.label).toBe(t('health.fresh', { count: data.sources.length }));
    expect(computeHealth(serverDemo(), broken, null, false, true).level).toBe('bad');
    expect(demo.faults).toEqual([]);
  });
});

it('group age uses the oldest enabled source, with probes only for groups without enabled sources', () => {
  const data = healthyDashboard();
  const group = groupsOf(data)[0];
  const old = '2026-10-13T10:00:00Z';
  group.sources[0].last_success = '2026-10-13T11:00:00Z';
  group.sources[1].last_success = old;
  expect(groupSummary(data, group).updated).toBe(old);
  group.sources[1].last_success = null;
  expect(groupSummary(data, group).updated).toBeUndefined();
  group.sources[1].enabled = false;
  expect(groupSummary(data, group).updated).toBe('2026-10-13T11:00:00Z');
  const manualGroup = groupsOf(data).find((group) => group.key.startsWith('platform:'))!;
  const times = data.instances
    .filter((instance) => instance.platform.toLowerCase() === manualGroup.key.slice(9))
    .map((instance) => instance.observed_at)
    .filter(Boolean)
    .sort();
  expect(groupSummary(data, manualGroup).updated).toBe(times[0]);
});

it.each(['en', 'zh-CN'] as const)(
  'uses translated subjects and overdue wording in %s',
  async (locale) => {
    setLocale(locale);
    const { attentionText, nextAttemptText, inventoryLabel } = await import('./health');
    const { sourceState } = await import('./labels');
    const data = serverDemo();
    const failed = data.sources.find((source) => source.error && source.stale)!;
    expect(sourceState(failed)).toBe('error');
    const item = data.attention![0];
    expect(
      attentionText(
        {
          ...item,
          kind: 'service_loop_failed',
          subject: { kind: 'service', id: 'collector:schedule', name: 'collector:schedule' },
          message: { code: 'attention_service_loop_failed' },
        },
        [],
      ),
    ).toContain(t('health.collector'));
    expect(
      attentionText(
        {
          ...item,
          kind: 'unreadable_rows',
          subject: { kind: 'service', id: 'jobs', name: 'jobs' },
          message: { code: 'attention_unreadable_rows', count: 2 },
        },
        [],
      ),
    ).toContain(t('health.inventory.jobs'));
    const tool = {
      id: 'example',
      name: { en: 'Example tool', 'zh-CN': '示例工具' },
    };
    const plugin = {
      ...item,
      kind: 'plugin_error',
      subject: { kind: 'plugin' as const, id: tool.id, name: tool.id },
      message: { code: 'attention_plugin_error' },
    };
    expect(attentionText(plugin, [tool])).toContain(locale === 'en' ? 'Example tool' : '示例工具');
    expect(inventoryLabel('jobs')).toBe(t('health.inventory.jobs'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const { dateTime } = await import('./domain');
    expect(nextAttemptText('2026-01-01T11:00:00Z')).toBe(
      t('health.overdue', { time: dateTime('2026-01-01T11:00:00Z') }),
    );
    expect(nextAttemptText('2026-01-01T13:00:00Z')).toBe(
      t('health.nextAttempt', { time: dateTime('2026-01-01T13:00:00Z') }),
    );
  },
);

it.each([1, 2])('matches attention severity after %s collection failures', (failures) => {
  const data = healthyDashboard();
  data.sources[0] = {
    ...data.sources[0],
    status: 'error',
    error: { code: 'ssh_timeout' },
    stale: false,
    failures,
  };
  expect(computeHealth(data, health, null, false, false).level).toBe(
    failures === 1 ? 'warn' : 'bad',
  );
  data.sources[0].stale = true;
  expect(computeHealth(data, health, null, false, false).level).toBe('bad');
});

it.each(['en', 'zh-CN'] as const)(
  'allows overdue grace and active collection in %s',
  async (locale) => {
    setLocale(locale);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const { nextAttemptText } = await import('./health');
    const { dateTime } = await import('./domain');
    for (const seconds of [-60, 0, 15, 120, 121, 600]) {
      const due = new Date(Date.now() - seconds * 1000).toISOString();
      expect(nextAttemptText(due)).toBe(
        t(seconds > 120 ? 'health.overdue' : 'health.nextAttempt', { time: dateTime(due) }),
      );
      expect(nextAttemptText(due, true)).toBe(t('health.nextAttempt', { time: dateTime(due) }));
    }
  },
);
