import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from './i18n';
import { failureEnd, failureExplanation, inspectionCommand } from './failures';
import { eventJob } from './events';
import type { DeckEvent, Job } from './types';

const job = (extra: Partial<Job> = {}) =>
  ({
    id: 'cluster-a:1001',
    cluster_id: 'cluster-a',
    state: 'FAILED',
    reason: null,
    ...extra,
  }) as Job;
afterEach(() => setLocale('en'));

describe.each(['en', 'zh-CN'] as const)('failure facts in %s', (locale) => {
  it.each(['OUT_OF_MEMORY', 'TIMEOUT', 'DEADLINE', 'NODE_FAIL', 'BOOT_FAIL', 'PREEMPTED'])(
    'prefers the reported %s cause over a signal hint',
    (state) => {
      setLocale(locale);
      for (const driver of ['slurm', 'pbs', 'lsf', 'kubernetes']) {
        const result = failureExplanation(job({ state, exit_signal: 9 }), driver)!;
        expect(result.summary).toContain(
          { slurm: 'Slurm', pbs: 'PBS', lsf: 'LSF', kubernetes: 'Kubernetes' }[driver],
        );
        expect(result.summary).not.toContain('SIGKILL');
        expect(result.evidence).toBeNull();
      }
    },
  );
  it('labels both heuristics with their normalized evidence', () => {
    setLocale(locale);
    expect(failureExplanation(job({ exit_signal: 9 }), 'slurm')).toEqual({
      summary: t('failure.sigkill'),
      evidence: t('failure.signalEvidence', { signal: 9 }),
    });
    expect(failureExplanation(job({ exit_status: 127 }), 'lsf')).toEqual({
      summary: t('failure.command'),
      evidence: t('failure.statusEvidence', { status: 127 }),
    });
    expect(failureExplanation(job({ reason: 'Error', exit_signal: 9 }), 'kubernetes')).toEqual({
      summary: null,
      evidence: null,
    });
    expect(failureExplanation(job({ reason: 'Error', exit_status: 127 }), 'kubernetes')).toEqual({
      summary: null,
      evidence: null,
    });
  });
  it('keeps program exits factual even when the scheduler supplies a reason', () => {
    setLocale(locale);
    for (const status of [1, 125]) {
      expect(
        failureExplanation(job({ reason: 'Error', exit_status: status }), 'kubernetes'),
      ).toEqual({ summary: t('failure.program', { status }), evidence: null });
    }
  });
  it('keeps program statuses factual, PBS negatives scheduler-owned and unknowns raw', () => {
    setLocale(locale);
    for (const status of [1, 125])
      expect(failureExplanation(job({ exit_status: status }), 'slurm')?.summary).toBe(
        t('failure.program', { status }),
      );
    expect(failureExplanation(job({ exit_code: '-3' }), 'pbs')?.summary).toBe(
      t('failure.schedulerCode', { code: '-3' }),
    );
    for (const code of ['137', '0:9', '265', '-3', '256', 'unknown']) {
      expect(failureExplanation(job({ exit_code: code }), 'kubernetes')).toEqual({
        summary: t('failure.rawCode', { code }),
        evidence: null,
      });
    }
    expect(failureExplanation(job({ exit_status: 137, exit_code: '137' }), 'lsf')?.summary).toBe(
      t('failure.rawCode', { code: '137' }),
    );
    expect(failureExplanation(job({ state: 'COMPLETED' }), 'slurm')).toBeNull();
  });
  it('does not treat a naive scheduler time as the browser local time', () => {
    setLocale(locale);
    expect(failureEnd(job({ end: '2026-01-05T10:00:00' }))).toBe(
      t('job.schedulerTime', { time: '2026-01-05T10:00:00' }),
    );
    expect(
      failureEnd(job({ end: '2026-01-05T10:00:00', ended_at: new Date().toISOString() })),
    ).not.toContain('2026-01-05');
  });
});

it('builds one copy-only command per driver and shell-quotes untrusted arguments', () => {
  expect(inspectionCommand(job(), 'slurm')).toBe(
    "sacct -j '1001' --format=JobID,State,ExitCode,Elapsed,Timelimit,ReqMem,MaxRSS,NodeList,WorkDir",
  );
  expect(inspectionCommand(job({ id: 'cluster-a:1001[2].server' }), 'pbs')).toBe(
    "qstat -fx '1001[2].server'",
  );
  expect(inspectionCommand(job({ id: 'cluster-a:1001[2]' }), 'lsf')).toBe("bhist -l '1001[2]'");
  expect(
    inspectionCommand(job({ id: 'cluster-a:research/train-abc', name: 'train' }), 'kubernetes'),
  ).toBe("kubectl describe pod -n 'research' 'train-abc'");
  expect(inspectionCommand(job({ id: "cluster-a:1'; touch /tmp/example" }), 'lsf')).toBe(
    "bhist -l '1'\\''; touch /tmp/example'",
  );
  expect(inspectionCommand(job(), 'third-party')).toBeNull();
  expect(inspectionCommand(job({ id: 'wrong:1' }), 'slurm')).toBeNull();
});

it('preserves partial event snapshots without fabricating resources or an unknown outcome', () => {
  const event = {
    type: 'job.finished',
    source_id: 'a-alice',
    data: {
      cluster_id: 'a',
      outcome: 'unknown',
      state: null,
      exit_code: null,
      job: { id: 'a:1', state: 'RUNNING' },
    },
  } as DeckEvent;
  expect(eventJob(event)).toMatchObject({
    state: 'unknown',
    exit_code: null,
    gpu_count: null,
    ended_at: undefined,
    end: null,
  });
  expect(eventJob({ ...event, type: 'source.failed' })).toBeNull();
});
