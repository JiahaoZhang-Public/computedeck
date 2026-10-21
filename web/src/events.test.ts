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
