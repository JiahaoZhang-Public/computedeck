import { afterEach, describe, expect, it, vi } from 'vitest';
import { attentionText, computeHealth } from './health';
import { groupsOf } from './groups';
import { groupSummary } from './pages/summary';
import { serverDashboard, serverDemo } from './test-server';
import { setLocale, t } from './i18n';
import type { Attention, Dashboard, Health } from './types';

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

// These unit tests isolate health precedence from the demo's deliberate source faults and its
// Needs attention list; each test adds the attention items it needs.
function healthyDashboard() {
  const data = serverDemo();
  data.sources = data.sources.filter((source) => !source.error && !source.stale);
  data.behind = [];
  data.as_of = data.sources.map((source) => source.last_success!).sort()[0];
  return withAttention(data, []);
}

/** Set the list and the served active count the way the server (and App, for local mutes) do. */
function withAttention(data: Dashboard, items: Attention[]) {
  data.attention = items;
  data.attention_count = items.filter((item) => !item.muted).length;
  return data;
}

// Attention items as the server derives them for the example fleet.
const demoAttention = serverDemo().attention!;
const pick = (match: (item: Attention) => boolean) =>
  demoAttention.filter(match).map((item) => structuredClone(item));
const activeWarnings = () => pick((item) => item.severity === 'warn' && !item.muted);
const activeError = () => pick((item) => item.kind === 'source_failed' && !item.muted)[0];
const mutedErrors = () => pick((item) => item.severity === 'error' && !!item.muted);
const dismissed = (item: Attention): Attention => ({
  ...item,
  muted: { state: 'acknowledged', at: '2026-10-13T12:00:00Z', until: null },
});

describe.each(['en', 'zh-CN'] as const)('freshness in %s', (locale) => {
  it('is quiet with the server age when nothing needs attention, and keeps age while collecting', () => {
    setLocale(locale);
    const data = healthyDashboard();
    data.sources[0].enabled = false;
    data.sources[0].error = 'offline';
    data.as_of = new Date(Date.now() - 8 * 60000).toISOString();
    const state = computeHealth(data, health, null, false, false);
    expect(state.quiet).toBe(true);
    expect(state.count).toBe(0);
    expect(state.age).toBe(t('time.minutesAgo', { count: 8 }));
    expect(state.label).toBe(state.age);
    expect(['warn', 'error']).not.toContain(state.level);
    expect(state.faults).toEqual([]);
    expect(state.rows.some((row) => row.collecting)).toBe(true);
    // Stale and failing sources reach the pill through the attention list, not their own flags.
    data.sources[1].stale = true;
    data.behind = [data.sources[1].id];
    data.sources[1].error = 'offline';
    expect(computeHealth(data, health, null, false, false).quiet).toBe(true);
    withAttention(data, [{ ...activeError(), severity: 'warn' }]);
    const warned = computeHealth(data, health, null, false, false);
    expect(warned.quiet).toBe(false);
    expect(warned.level).toBe('warn');
    expect(warned.label).toBe(t('health.attention', { count: 1 }));
    expect(warned.count).toBe(1);
    expect(warned.age).toBe(t('time.minutesAgo', { count: 8 }));
    withAttention(data, [activeError()]);
    expect(computeHealth(data, health, null, false, false).level).toBe('error');
  });

  it('keeps first load, token gate, no sources and missing success honest', () => {
    setLocale(locale);
    const first = computeHealth(null, null, null, false, false);
    expect(first.level).toBe('unknown');
    expect(first.label).toBe(t('health.unknown'));
    expect(first.count).toBe(0);
    const data = withAttention(healthyDashboard(), [activeError(), ...activeWarnings()]);
    const gated = computeHealth(data, health, 'unauthorized', true, false);
    expect(gated.level).toBe('unknown');
    expect(gated.label).toBe(t('health.unknown'));
    expect(gated.age).toBe(t('health.unknown'));
    expect(gated.quiet).toBe(false);
    // The token gate decides: no count from a list the viewer may not read.
    expect(gated.count).toBe(0);
    expect(gated.rows).toEqual([]);
    withAttention(data, []);
    data.sources[0].last_success = null;
    data.as_of = null;
    const uncollected = computeHealth(data, health, null, false, false);
    expect(uncollected.age).toBe(t('health.notCollected'));
    // Quiet still never invents an age.
    expect(uncollected.quiet).toBe(true);
    expect(uncollected.label).toBe(t('health.notCollected'));
    data.sources = [];
    const none = computeHealth(data, health, null, false, false);
    expect(none.level).toBe('unknown');
    expect(none.label).toBe(t('health.noSourcesConnected'));
    expect(none.quiet).toBe(false);
  });

  it.each([1, 2])(
    'counts active attention items and takes the level from their severity (%s)',
    (count) => {
      setLocale(locale);
      const data = healthyDashboard();
      data.sources = data.sources.slice(0, 2);
      for (const source of data.sources.slice(0, count)) source.stale = true;
      expect(computeHealth(data, health, null, false, false).quiet).toBe(true);
      const warnings = activeWarnings();
      expect(warnings.length).toBeGreaterThanOrEqual(2);
      withAttention(data, warnings.slice(0, count));
      const warned = computeHealth(data, health, null, false, false);
      expect(warned.level).toBe('warn');
      expect(warned.label).toBe(t('health.attention', { count }));
      expect(warned.count).toBe(count);
      expect(warned.quiet).toBe(false);
      // One error among the active items makes the pill an error.
      withAttention(data, [...warnings.slice(0, count), activeError()]);
      const failed = computeHealth(data, health, null, false, false);
      expect(failed.level).toBe('error');
      expect(failed.label).toBe(t('health.attention', { count: count + 1 }));
      expect(failed.count).toBe(count + 1);
    },
  );

  it.each([1, 2])('uses singular and plural labels (%s)', (count) => {
    setLocale(locale);
    const expected =
      locale === 'en'
        ? {
            backoff: ['backing off after 1 failure', 'backing off after 2 failures'],
            unreadable: ['1 stored row could not be read', '2 stored rows could not be read'],
            attention: ['1 needs attention', '2 need attention'],
          }
        : {
            backoff: ['已失败 1 次，延后重试', '已失败 2 次，延后重试'],
            unreadable: ['无法读取 1 条存储记录', '无法读取 2 条存储记录'],
            attention: ['1 项需要处理', '2 项需要处理'],
          };
    for (const key of ['backoff', 'unreadable', 'attention'] as const) {
      expect(t(`health.${key}`, { count })).toBe(expected[key][count - 1]);
    }
    const data = healthyDashboard();
    data.sources = data.sources.slice(0, count);
    // A behind source without an attention item leaves the pill quiet on its age.
    data.behind = data.sources.map((source) => source.id);
    const quiet = computeHealth(data, health, null, false, false);
    expect(quiet.quiet).toBe(true);
    expect(quiet.label).toBe(quiet.age);
    withAttention(data, activeWarnings().slice(0, count));
    expect(computeHealth(data, health, null, false, false).label).toBe(
      expected.attention[count - 1],
    );
    const broken = { ...health, unreadable_rows: { snapshots: count } };
    const unreadable = computeHealth(data, broken, null, false, false);
    expect(unreadable.label).toBe(expected.unreadable[count - 1]);
    expect(unreadable.level).toBe('error');
    expect(unreadable.count).toBe(0);
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
      expect(state.quiet).toBe(false);
      expect(state.count).toBe(0);
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
    const removed = computeHealth(data, { ...broken, plugins: {} }, null, false, false);
    expect(removed.faults).toEqual([]);
    expect(removed.quiet).toBe(true);
    // A failing source still shows, through its attention item rather than a plugin fault.
    data.sources[0].error = 'offline';
    withAttention(data, [activeError()]);
    const failing = computeHealth(data, broken, null, false, false);
    expect(failing.faults).toEqual([]);
    expect(failing.level).toBe('error');
    expect(failing.label).toBe(t('health.attention', { count: 1 }));
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
    expect(state.level).toBe('error');
    expect(state.label).toBe(t('health.nodeFault', { name: 'Relay A' }));
    expect(state.faults[0].page).toBe('sources');
    // The example list has active items, but the route fault decides, so no count shows.
    expect(state.count).toBe(0);
    expect(state.quiet).toBe(false);
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
    expect(state.level).toBe('error');
    expect(state.label).toBe(t('health.collectorFault'));
    expect(state.collectorFault).toBe(true);
    expect(state.faults.map((fault) => fault.title)).toEqual([
      t('health.collectorFault'),
      t('health.unreadable', { count: 2 }),
    ]);
    const off = computeHealth(data, { ...health, polling: false }, null, false, false);
    expect(off.level).toBe('off');
    expect(off.label).toBe(t('health.pollingOff'));
    expect(off.quiet).toBe(false);
    // Items needing attention outrank polling off; a fault or an unreachable service outranks them.
    withAttention(data, activeWarnings());
    expect(computeHealth(data, { ...health, polling: false }, null, false, false).label).toBe(
      t('health.attention', { count: activeWarnings().length }),
    );
    const unreachable = computeHealth(data, broken, 'offline', false, false);
    expect(unreachable.level).toBe('error');
    expect(unreachable.label).toBe(t('health.unreachable'));
    expect(unreachable.count).toBe(0);
    withAttention(data, []);
    const demo = computeHealth(data, broken, null, false, true);
    expect(demo.quiet).toBe(true);
    expect(demo.label).toBe(demo.age);
    expect(demo.faults).toEqual([]);
    expect(demo.collectorFault).toBe(false);
    const example = serverDemo();
    const exampleState = computeHealth(example, broken, null, false, true);
    expect(exampleState.faults).toEqual([]);
    expect(exampleState.level).toBe('error');
    expect(exampleState.count).toBe(example.attention!.filter((item) => !item.muted).length);
    expect(exampleState.label).toBe(t('health.attention', { count: exampleState.count }));
  });

  it('never counts dismissed or snoozed items, while service faults always show', () => {
    setLocale(locale);
    const data = healthyDashboard();
    const muted = mutedErrors();
    expect(muted.map((item) => item.muted!.state).sort()).toEqual(['acknowledged', 'snoozed']);
    // Muted error items leave the pill quiet, with the served count and without it.
    withAttention(data, muted);
    expect(data.attention_count).toBe(0);
    for (const served of [0, undefined]) {
      data.attention_count = served;
      const state = computeHealth(data, health, null, false, false);
      expect(state.quiet).toBe(true);
      expect(state.count).toBe(0);
      expect(state.label).toBe(state.age);
      expect(['warn', 'error']).not.toContain(state.level);
    }
    // Dismissing the only error item leaves the warnings, at warning level.
    withAttention(data, [...muted, dismissed(activeError()), ...activeWarnings()]);
    const warned = computeHealth(data, health, null, false, false);
    expect(warned.level).toBe('warn');
    expect(warned.count).toBe(activeWarnings().length);
    // Older services send no count: the unmuted items decide.
    delete data.attention_count;
    expect(computeHealth(data, health, null, false, false).count).toBe(activeWarnings().length);
    // A collector fault is never dismissible: it shows while every attention item is muted.
    const broken = {
      ...health,
      background_errors: { collector: { at: '2026-10-13T12:00:00Z', error: 'database is locked' } },
    };
    withAttention(data, muted);
    const fault = computeHealth(data, broken, null, false, false);
    expect(fault.quiet).toBe(false);
    expect(fault.level).toBe('error');
    expect(fault.label).toBe(t('health.collectorFault'));
    expect(fault.collectorFault).toBe(true);
    expect(fault.count).toBe(0);
    // With active items too, the fault decides the label and the count is 0.
    withAttention(data, [...muted, activeError(), ...activeWarnings()]);
    const both = computeHealth(data, broken, null, false, false);
    expect(both.label).toBe(t('health.collectorFault'));
    expect(both.count).toBe(0);
    expect(computeHealth(data, health, null, false, false).count).toBe(1 + activeWarnings().length);
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
  // The server derives the source's attention item; the pill takes its severity.
  const derive = () => {
    const rest = { ...data };
    delete rest.attention;
    delete rest.attention_count;
    const items = serverDashboard(rest).attention!.filter(
      (item) => item.subject.id === data.sources[0].id,
    );
    expect(items.map((item) => item.kind)).toEqual(['source_failed']);
    return withAttention(data, items).attention![0].severity;
  };
  expect(derive()).toBe(failures === 1 ? 'warn' : 'error');
  expect(computeHealth(data, health, null, false, false).level).toBe(
    failures === 1 ? 'warn' : 'error',
  );
  data.sources[0].stale = true;
  expect(derive()).toBe('error');
  expect(computeHealth(data, health, null, false, false).level).toBe('error');
  withAttention(data, data.attention!.map(dismissed));
  expect(computeHealth(data, health, null, false, false).quiet).toBe(true);
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

it.each(['en', 'zh-CN'] as const)(
  'keeps the timeout for the detail and a short, complete notification title (%s)',
  (locale) => {
    setLocale(locale);
    const item = serverDemo().attention!.find((entry) => entry.kind === 'notification_failed')!;
    // The server keeps the timeout parameters; the title names only the channel, never the why.
    expect(item.message.error).toEqual({ code: 'send_timeout', seconds: 30 });
    const title = t('msg.attention_notification_failed', { channel: String(item.message.channel) });
    const text = attentionText(item, []);
    expect(text).toBe(title);
    expect(text).not.toContain('{');
    expect(text).not.toContain(t('msg.send_timeout', { seconds: 30 }));
    delete item.message.error;
    expect(attentionText(item, [])).toBe(title);
    expect(attentionText(item, [])).not.toContain(t('msg.send_timeout_unknown'));
  },
);
