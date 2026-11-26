import { afterEach, expect, it } from 'vitest';
import { duration } from './format';
import { jobElapsed, jobReason, jobTime, jobWaiting, reasonCode, reasonKind } from './jobFacts';
import { setLocale, t } from './i18n';
import type { Job } from './types';

afterEach(() => setLocale('en'));

it.each([' (details)', ',details', ':details', ' details', ''])(
  'uses the same reason classification with suffix %s',
  (suffix) => {
    const reason = `AssocMaxJobsLimit${suffix}`;
    expect(reasonCode(reason)).toBe('AssocMaxJobsLimit');
    expect(reasonKind(reasonCode(reason), 'slurm')).toBe('personalLimit');
    expect(jobReason({ state: 'PENDING', reason }, 'slurm')?.kind).toBe(
      reasonKind(reasonCode(reason), 'slurm'),
    );
    expect(reasonKind(reasonCode(reason), 'pbs')).toBe('unknown');
    expect(reasonKind(reasonCode(null), 'slurm')).toBe('unknown');
  },
);

it.each(['en', 'zh-CN'] as const)('explains scheduler limits and next steps in %s', (locale) => {
  setLocale(locale);
  const result = jobReason({ state: 'PENDING', reason: 'QOSMaxGRESPerUser' }, 'slurm');
  expect(result?.summary).toBe(t('job.explain.personalLimit'));
  expect(result?.next).toBe(t('job.next.personalLimit'));
  const unknown = jobReason({ state: 'PENDING', reason: 'SiteSpecificCode' }, 'slurm');
  expect(unknown?.summary).toBe(t('job.explain.unknown'));
  expect(jobReason({ state: 'PENDING', reason: 'Priority' }, 'pbs')?.summary).toBe(
    t('job.explain.unknown'),
  );
});
it.each(['OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'FAILED', 'PREEMPTED'])(
  'gives a next step for %s',
  (state) => {
    expect(jobReason({ state, reason: null }, '')?.next).toBeTruthy();
  },
);
it('does not interpret scheduler-local text in the browser timezone', () => {
  expect(jobTime('Jan 5 10:00')).toBe(t('job.schedulerTime', { time: 'Jan 5 10:00' }));
  expect(jobTime(null)).toBe('—');
});
it('bounds waits by observation time and preserves unknown timestamps', () => {
  const job = {
    state: 'PENDING',
    submitted_at: '2026-01-05T10:00:00+04:00',
    observed_at: '2026-01-05T08:30:00Z',
    started_at: null,
  } as Job;
  expect(jobWaiting(job)).toBe(duration(2.5 * 3600));
  expect(jobElapsed('1-06:12:04')).toBe(duration(30 * 3600 + 12 * 60 + 4));
  expect(jobElapsed('00:42:00')).toBe(duration(42 * 60));
  expect(jobElapsed('about an hour')).toBe('about an hour');
  expect(jobElapsed(null)).toBe('—');
  expect(jobWaiting({ ...job, state: 'RUNNING' })).toBe('—');
  expect(jobWaiting({ ...job, submitted_at: '2026-01-05T10:00:00' })).toBe('—');
  expect(jobWaiting({ ...job, observed_at: '2025-01-01T00:00:00Z' })).toBe('—');
});

it.each([
  'QOSMaxSubmitJobPerUserLimit',
  'QOSMaxCpuPerUserLimit',
  'AssocMaxJobsLimit',
  'AssocMaxSubmitJobLimit',
])('shares the personal-limit class for %s with the planner', (reason) => {
  for (const locale of ['en', 'zh-CN'] as const) {
    setLocale(locale);
    expect(jobReason({ state: 'PENDING', reason: `${reason} (details)` }, 'slurm')).toMatchObject({
      kind: 'personalLimit',
      summary: t('job.explain.personalLimit'),
    });
  }
});

it.each(['AssocMaxGRESPerUser', 'AssocMaxCpuPerUserLimit'])(
  'leaves undocumented reason %s unexplained',
  (reason) => {
    expect(jobReason({ state: 'PENDING', reason }, 'slurm')?.kind).toBe('unknown');
  },
);
