import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventText,
  eventTone,
  OUTCOME_LABELS,
  activityEvents,
  eventTimeTitle,
  eventTimeText,
} from './events';
import { setLocale, t } from './i18n';
import { dateTime } from './domain';
import type { DeckEvent } from './types';

const event = (type: string, data: DeckEvent['data']): DeckEvent => ({
  id: 1,
  type,
  at: '2026-01-01T00:00:00Z',
  source_id: 'cluster-a-alice',
  data: { source_name: 'Cluster A', ...data },
});

describe('event wording', () => {
  afterEach(() => setLocale('en'));
  it('describes job and source changes', () => {
    expect(eventText(event('job.started', { job: { name: 'train', node: 'g1' } }))).toBe(
      'train started on g1',
    );
    expect(
      eventText(
        event('job.failed', { job: { name: 'train', state: 'OUT_OF_MEMORY', exit_code: '0:125' } }),
      ),
    ).toBe(`train failed (${t('status.OUT_OF_MEMORY')}, exit code 0:125)`);
    expect(eventText(event('source.failed', { error: { code: 'timeout' } }))).toContain(
      'Cluster A',
    );
    setLocale('zh-CN');
    expect(eventText(event('source.recovered', {}))).toBe('Cluster A 已恢复采集');
  });
  it('colours failures red and starts green', () => {
    expect(eventTone(event('job.failed', {}))).toBe('red');
    expect(eventTone(event('job.started', {}))).toBe('green');
    expect(eventTone(event('job.ended', {}))).toBe('gray');
  });
});

// A terminal outcome is one row; a late observation is distinct from the end time.
describe('reconciled job endings', () => {
  afterEach(() => setLocale('en'));
  it.each(['en', 'zh-CN'] as const)('renders all outcomes and unknown reasons in %s', (locale) => {
    setLocale(locale);
    for (const outcome of Object.keys(OUTCOME_LABELS)) {
      const row = event('job.finished', { outcome, job: { name: 'train' } });
      expect(eventText(row)).toContain(t(OUTCOME_LABELS[outcome]));
      expect(eventTone(row)).toBe(
        outcome === 'completed'
          ? 'green'
          : ['unknown', 'cancelled'].includes(outcome)
            ? 'gray'
            : 'red',
      );
    }
    expect(
      eventText(
        event('job.finished', { outcome: 'unknown', outcome_reason: 'outcomes_unavailable' }),
      ),
    ).toContain(t('event.outcomesUnavailable'));
    expect(eventText(event('job.finished', { outcome: 'unknown' }))).toContain(
      t('event.outcomeNotReported'),
    );
  });
  it.each(['en', 'zh-CN'] as const)(
    'labels unknown start times as observations in %s',
    (language) => {
      setLocale(language);
      expect(eventTimeTitle(event('job.started', { started_at: null }))).toContain(
        t('event.observedStartTime'),
      );
      expect(
        eventTimeTitle(event('job.started', { started_at: '2026-01-01T00:00:00Z' })),
      ).not.toContain(t('event.observedStartTime'));
    },
  );
  it('labels end and observation times and suppresses the old pair for migrated sources', () => {
    const row = event('job.finished', {
      outcome: 'completed',
      ended_at: '2026-01-01T00:00:00Z',
      observed_at: '2026-01-01T00:05:00Z',
    });
    expect(eventTimeTitle(row)).toContain('seen 5 min later');
    expect(eventTimeText(row)).toContain('ended');
    expect(eventTimeTitle(event('job.finished', { outcome: 'unknown' }))).toContain(
      'observation time',
    );
    const old = { ...event('job.failed', {}), source_id: 'cluster-b' };
    expect(activityEvents([event('job.ended', {}), event('job.failed', {}), row, old])).toEqual([
      row,
      old,
    ]);
  });
});

describe('Activity dates in the app language', () => {
  afterEach(() => {
    vi.useRealTimers();
    setLocale('en');
  });
  it.each(['en', 'zh-CN'] as const)(
    'shows time today and date plus time for older endings in %s',
    (language) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 2, 16, 0));
      setLocale(language);
      for (const day of [2, 1]) {
        const ended = new Date(2026, 0, day, 14, 2);
        const at = ended.toISOString();
        const row = {
          ...event('job.finished', { outcome: 'completed', ended_at: at, observed_at: at }),
          at,
        };
        const full = ended.toLocaleString(language, {
          hour12: false,
          dateStyle: 'short',
          timeStyle: 'short',
        });
        expect(eventTimeText(row)).toBe(t('event.endedAt', { time: day === 2 ? '14:02' : full }));
        expect(eventTimeTitle(row)).toBe(full);
      }
    },
  );
});

it('keeps time provenance on catch-up children', () => {
  setLocale('en');
  const row = event('job.finished', {
    outcome: 'unknown',
    since: '2025-12-31T23:00:00Z',
    observed_at: '2026-01-01T00:00:00Z',
  });
  expect(eventTimeText(row)).toContain('between');
  expect(eventTimeTitle(row)).toContain('observation time');
});

describe('catch-up time precedence and group outcomes', () => {
  afterEach(() => setLocale('en'));
  const since = '2026-01-01T08:10:00Z';
  const observed = '2026-01-01T11:20:00Z';
  const first = '2026-01-01T09:00:00Z';
  const last = '2026-01-01T10:00:00Z';
  function child(kind: string, at: string, known: boolean): DeckEvent {
    return {
      ...event(kind, {
        since,
        observed_at: observed,
        ended_at: kind === 'job.finished' && known ? at : null,
        started_at: kind === 'job.started' && known ? at : null,
      }),
      at,
    };
  }
  function group(children: DeckEvent[]): DeckEvent {
    return {
      ...children[0],
      group: {
        count: children.length,
        ids: children.map((row) => row.id),
        first_at: children[0].at,
        last_at: children.at(-1)!.at,
        names: [{ name: 'train-sweep', count: children.length }],
        events: children,
        outcomes: { completed: 48, failed: 2 },
      },
    };
  }
  it.each(['en', 'zh-CN'] as const)(
    'uses own times before the observation window in %s',
    (language) => {
      setLocale(language);
      const known = child('job.finished', first, true);
      expect(eventTimeText(known)).toBe(t('event.endedAt', { time: dateTime(first) }));
      expect(eventTimeText(child('job.started', first, true))).toBeNull();
      const regular = child('job.started', first, true);
      delete regular.data.since;
      expect(eventTimeText(regular)).toBeNull();
      for (const kind of ['job.started', 'job.finished']) {
        expect(eventTimeText(child(kind, observed, false))).toBe(
          t('event.between', {
            start: dateTime(since),
            end: dateTime(observed),
          }),
        );
        expect(eventTimeText(group([child(kind, first, true), child(kind, last, true)]))).toBe(
          t('event.between', { start: dateTime(first), end: dateTime(last) }),
        );
        expect(eventTimeText(group([child(kind, first, true), child(kind, observed, false)]))).toBe(
          t('event.between', { start: dateTime(since), end: dateTime(observed) }),
        );
        expect(eventTimeText(group([child(kind, first, true), child(kind, first, true)]))).toBe(
          dateTime(first),
        );
        const unknown = child(kind, observed, false);
        unknown.data.since = observed;
        expect(eventTimeText(group([unknown, unknown]))).toBe(dateTime(observed));
      }
    },
  );
  it.each(['en', 'zh-CN'] as const)(
    'names outcome counts with failures first in %s',
    (language) => {
      setLocale(language);
      const row = group([child('job.finished', first, true), child('job.finished', last, true)]);
      expect(eventText(row)).toContain(
        `2 ${t('event.outcome.failed')} · 48 ${t('event.outcome.completed')}`,
      );
    },
  );
});

describe('short Activity ranges', () => {
  afterEach(() => {
    vi.useRealTimers();
    setLocale('en');
  });
  it.each(['en', 'zh-CN'] as const)('formats each endpoint independently in %s', (language) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 21, 18, 0));
    setLocale(language);
    const today = new Date(2026, 9, 21, 17, 53).toISOString();
    const later = new Date(2026, 9, 21, 17, 56).toISOString();
    const yesterday = new Date(2026, 9, 20, 17, 53).toISOString();
    for (const [first, last, expected] of [
      [today, later, t('event.between', { start: '17:53', end: '17:56' })],
      [yesterday, later, t('event.between', { start: dateTime(yesterday), end: '17:56' })],
      [today, today, '17:53'],
    ]) {
      const child = event('job.finished', { since: first, observed_at: last });
      expect(eventTimeText(child)).toBe(expected);
      const group: DeckEvent = {
        ...child,
        group: {
          count: 3,
          ids: [1, 2, 3],
          first_at: first,
          last_at: last,
          names: [],
          events: [{ ...child, data: { ended_at: first } }],
        },
      };
      expect(eventTimeText(group)).toBe(expected);
      group.group!.events = [child]; // unknown child uses the observation window
      expect(eventTimeText(group)).toBe(expected);
    }
  });
});

it.each(['en', 'zh-CN'] as const)('identifies array elements in %s', (language) => {
  setLocale(language);
  for (const [id, array, index, label] of [
    ['cluster-a:48200_3', '48200', '3', '48200_3'],
    ['cluster-a:123[4]', '123[]', '4', '123[4]'],
    [undefined, '48200', '3', '3'],
  ]) {
    const row = event('job.finished', {
      outcome: 'failed',
      job: {
        id,
        name: 'train-sweep',
        array_id: array,
        array_index: index,
      },
    });
    expect(eventText(row)).toBe(
      t('event.jobFinished', {
        job: `train-sweep [${label}]`,
        outcome: t('event.outcome.failed'),
      }),
    );
  }
  setLocale('en');
});
