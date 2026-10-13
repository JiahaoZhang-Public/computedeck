import { afterEach, describe, expect, it } from 'vitest';
import { eventText, eventTone } from './events';
import { setLocale } from './i18n';
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
    ).toBe('train failed (OUT_OF_MEMORY, exit code 0:125)');
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
