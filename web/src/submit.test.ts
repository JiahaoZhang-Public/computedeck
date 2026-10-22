import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from './i18n';
import { uniqueNodes } from './domain';
import { planOptions } from './plan';
import type { PlanRequest, Verdict } from './plan';
import { canCopySubmit, jobPlanLink, planPresets, submitFlags } from './submit';
import { serverDemo } from './test-server';

const demo = serverDemo();
const request: PlanRequest = { gpus: 4, gpuType: 'a100', hours: 24.5 };
function fixture() {
  const data = structuredClone(demo);
  const option = planOptions(data, request).find(
    (item) => item.source.id === data.jobs[0].source_id && item.qos === 'normal',
  )!;
  option.verdict = 'possible';
  option.rule = null;
  const job = { ...data.jobs[0], gpu_type: 'A100', partition: 'gpu', account: 'research' };
  const node = {
    ...data.nodes[0],
    source_id: option.evidence.nodes[0].source.id,
    gpu_type: 'A100',
    gpu_count: 8,
    health: 'usable' as const,
    partitions: ['gpu'],
  };
  return { data, option, job, node };
}
afterEach(() => setLocale('en'));

describe('copy-only Slurm flags', () => {
  it('uses this login’s unambiguous jobs and scheduler model spelling', () => {
    const { option, job, node } = fixture();
    const result = submitFlags(option, request, [job], [node], 'line')!;
    expect(result).toEqual({
      text: '-q normal -p gpu -A research --gres=gpu:A100:4 -t 1-00:30:00',
      notes: [],
    });
    expect(result.text).not.toMatch(/sbatch|srun|#|\n/);
  });
  it('does not borrow account or partition from another cluster, user or QoS', () => {
    const { option, job, node } = fixture();
    const jobs = [
      { ...job, source_id: 'other', cluster_id: 'other' },
      { ...job, user: 'bob' },
      { ...job, qos: 'other' },
    ];
    const result = submitFlags(option, request, jobs, [node], 'line')!;
    expect(result.text).toBe('-q normal --gres=gpu:A100:4 -t 1-00:30:00');
    expect(result.notes).toEqual([t('plan.submit.unknown', { flags: '-p, -A' })]);
  });
  it.each(['en', 'zh-CN'] as const)(
    'copies the option QoS and node model with no own jobs, with one combined note (%s)',
    (locale) => {
      setLocale(locale);
      const { option, node } = fixture();
      const result = submitFlags(option, request, [], [node], 'line')!;
      expect(result).toEqual({
        text: '-q normal --gres=gpu:A100:4 -t 1-00:30:00',
        notes: [t('plan.submit.unknown', { flags: '-p, -A' })],
      });
    },
  );
  it.each([null, '', 'unsafe;name', 'unsafe\n#SBATCH --exclusive'])(
    'omits a missing or unsafe QoS %s with a note',
    (qos) => {
      const { option, node } = fixture();
      const result = submitFlags({ ...option, qos }, request, [], [node], 'line')!;
      expect(result.text).toBe('--gres=gpu:A100:4 -t 1-00:30:00');
      expect(result.notes).toEqual([t('plan.submit.unknown', { flags: '-q, -p, -A' })]);
    },
  );
  it.each(['usable', 'on_demand', 'unavailable', 'unknown'] as const)(
    'uses current %s node model spelling independently of jobs and node health',
    (health) => {
      const { option, node } = fixture();
      const result = submitFlags(
        option,
        request,
        [],
        [{ ...node, health, gpu_type: 'H100, A100' }],
        'line',
      )!;
      expect(result.text).toContain('--gres=gpu:A100:4');
      expect(result.notes).not.toContain(t('plan.submit.model'));
    },
  );
  it('omits a model with no current matching node even if an own job reports it', () => {
    const { option, job, node } = fixture();
    for (const nodes of [
      [],
      [{ ...node, gpu_type: 'H100' }],
      [{ ...node, gpu_type: null }],
      [{ ...node, cluster_id: 'other' }],
      [{ ...node, source_id: 'unobserved' }],
    ]) {
      const result = submitFlags(option, request, [job], nodes, 'line')!;
      expect(result.text).toContain('--gres=gpu:4');
      expect(result.notes).toContain(t('plan.submit.model'));
    }
    option.evidence.nodes.forEach((item) => {
      item.current = false;
    });
    const stale = submitFlags(option, request, [job], [node], 'line')!;
    expect(stale.text).toContain('--gres=gpu:4');
    expect(stale.notes).toContain(t('plan.submit.model'));
  });
  it('requires one distinct model spelling across current nodes', () => {
    const { option, node } = fixture();
    const second = { ...node, id: 'another', name: 'another', gpu_type: 'a100' };
    const ambiguous = submitFlags(option, request, [], [node, second], 'line')!;
    expect(ambiguous.text).toContain('--gres=gpu:4');
    expect(ambiguous.notes).toContain(t('plan.submit.model'));
    const same = submitFlags(option, request, [], [node, { ...second, gpu_type: 'A100' }], 'line')!;
    expect(same.text).toContain('--gres=gpu:A100:4');
    expect(same.notes).not.toContain(t('plan.submit.model'));
  });
  it('uses account and partition from a same-account twin and rejects conflicting twin values', () => {
    const { option, job, node } = fixture();
    const twin = { ...job, source_id: 'twin' };
    expect(submitFlags(option, request, [twin], [node], 'line')!.text).toBe(
      '-q normal -p gpu -A research --gres=gpu:A100:4 -t 1-00:30:00',
    );
    const conflict = submitFlags(
      option,
      request,
      [job, { ...twin, partition: 'other', account: 'other' }],
      [node],
      'line',
    )!;
    expect(conflict.text).not.toMatch(/-p | -A /);
    expect(conflict.notes).toEqual([t('plan.submit.unknown', { flags: '-p, -A' })]);
  });
  it('omits conflicting accounts and partitions, and partitions without a healthy matching node', () => {
    const { option, job, node } = fixture();
    expect(
      submitFlags(
        option,
        request,
        [job, { ...job, account: 'other', partition: 'other' }],
        [node],
        'line',
      )!.text,
    ).toBe('-q normal --gres=gpu:A100:4 -t 1-00:30:00');
    for (const changed of [
      { ...node, partitions: ['other'] },
      { ...node, health: 'on_demand' as const },
      { ...node, gpu_type: 'H100' },
    ]) {
      expect(submitFlags(option, request, [job], [changed], 'line')!.text).not.toContain('-p ');
    }
    option.evidence.nodes.forEach((item) => {
      item.current = false;
    });
    expect(submitFlags(option, request, [job], [node], 'line')!.text).not.toContain('-p ');
  });
  it('checks the newest node observation before considering its partition', () => {
    const { option, job, node } = fixture();
    const newer = { ...node, health: 'unavailable' as const, observed_at: '2099-01-01T00:00:00Z' };
    expect(
      submitFlags(option, request, [job], uniqueNodes([node, newer]), 'line')!.text,
    ).not.toContain('-p ');
  });
  it.each(['A100 80GB', 'A100,H100', '$(touch /tmp/no)', 'A100\n#SBATCH --exclusive'])(
    'never copies unsafe or multiple model spelling %s',
    (model) => {
      const { option, job, node } = fixture();
      const result = submitFlags(
        option,
        { ...request, gpuType: model },
        [{ ...job, gpu_type: model }],
        [{ ...node, gpu_type: model }],
        'line',
      )!;
      expect(result.text).toContain('--gres=gpu:4');
      expect(result.text).not.toContain(model);
      expect(result.notes).toContain(t('plan.submit.model'));
    },
  );
  it('does not interpolate unsafe scheduler values into either format', () => {
    const { option, job, node } = fixture();
    const value = 'normal\n#SBATCH --exclusive';
    for (const format of ['line', 'header'] as const) {
      const result = submitFlags(
        { ...option, qos: value },
        request,
        [{ ...job, qos: value, partition: 'gpu;id', account: '$(id)' }],
        [node],
        format,
      )!;
      expect(result.text).not.toMatch(/exclusive|;id|\$\(/);
    }
  });
  it('uses exact uniform node capacity, never free GPU count, for multi-node flags', () => {
    const { option, job, node } = fixture();
    const result = submitFlags(
      option,
      { ...request, gpus: 16 },
      [job],
      [{ ...node, gpu_allocated: 6 }],
      'line',
    )!;
    expect(result.text).toContain('--nodes=2 --gres=gpu:A100:8');
    const ordinary = submitFlags(option, request, [job], [{ ...node, gpu_allocated: 6 }], 'line')!;
    expect(ordinary.text).not.toContain('--nodes');
    expect(ordinary.notes).not.toContain(t('plan.submit.multiNode'));
  });
  it('does not invent a layout for heterogeneous, mixed-model, unknown or indivisible nodes', () => {
    const { option, job, node } = fixture();
    for (const nodes of [
      [node, { ...node, id: 'other', name: 'other', gpu_count: 4 }],
      [{ ...node, gpu_count: null }],
      [{ ...node, gpu_type: 'A100,H100' }],
    ]) {
      expect(
        submitFlags(option, { ...request, gpus: 16 }, [job], nodes, 'line')!.text,
      ).not.toContain('--nodes');
    }
    const partial = submitFlags(option, { ...request, gpus: 10 }, [job], [node], 'line')!;
    expect(partial.text).not.toContain('--nodes');
    expect(partial.notes).toContain(t('plan.submit.multiNode'));
  });
  it.each(['en', 'zh-CN'] as const)(
    'keeps unknown notes outside copied text in both formats (%s)',
    (locale) => {
      setLocale(locale);
      const { option, job, node } = fixture();
      const jobs = [{ ...job, partition: null, account: '' }];
      const line = submitFlags(option, request, jobs, [node], 'line')!;
      const header = submitFlags(option, request, jobs, [node], 'header')!;
      expect(line.text).toBe('-q normal --gres=gpu:A100:4 -t 1-00:30:00');
      expect(header.text).toBe(
        ['#SBATCH -q normal', '#SBATCH --gres=gpu:A100:4', '#SBATCH -t 1-00:30:00'].join('\n'),
      );
      expect(line.notes).toContain(t('plan.submit.unknown', { flags: '-p, -A' }));
    },
  );
  it.each([
    [null, null],
    [0, null],
    [1 / 3, '0-00:20:00'],
    [1.1, '0-01:06:00'],
    [0.001, '0-00:01:00'],
    [25.25, '1-01:15:00'],
  ] as const)('formats requested %s hours as %s', (hours, expected) => {
    const { option, job, node } = fixture();
    const result = submitFlags(option, { ...request, hours }, [job], [node], 'line')!;
    if (expected) expect(result.text).toContain(`-t ${expected}`);
    else expect(result.text).not.toContain('-t ');
  });
  it.each([
    'likely',
    'possible',
    'behind',
    'busy',
    'limit',
    'wall',
    'denied',
    'none',
    'unavailable',
    'unknown',
  ] as Verdict[])('gates %s options', (verdict) => {
    const { option, job, node } = fixture();
    option.verdict = verdict;
    const allowed = ['likely', 'possible', 'behind', 'busy'].includes(verdict);
    expect(canCopySubmit(option)).toBe(allowed);
    expect(submitFlags(option, request, [job], [node], 'line') !== null).toBe(allowed);
  });
  it('refuses unsupported drivers and a deciding per-job rule', () => {
    const { option } = fixture();
    for (const driver of ['pbs', 'lsf', 'kubernetes', 'ssh', 'plugin']) {
      expect(canCopySubmit({ ...option, source: { ...option.source, driver } })).toBe(false);
    }
    expect(
      canCopySubmit({ ...option, rule: { kind: 'perJob', effect: 'doubt', limit: 2, used: null } }),
    ).toBe(false);
  });
});

describe('job presets', () => {
  it('encodes job ids and uses only a single model present in the planner', () => {
    const { job, node } = fixture();
    const link = jobPlanLink({ ...job, id: 'cluster:123_1 & more' }, [node]);
    const params = new URLSearchParams(link.split('?')[1]);
    expect(params.get('from')).toBe('cluster:123_1 & more');
    expect(params.get('gpus')).toBe('4');
    expect(params.get('model')).toBe('A100');
    expect(params.has('hours')).toBe(false);
    for (const model of ['A100,H100', 'unlisted', null])
      expect(jobPlanLink({ ...job, gpu_type: model }, [node])).not.toContain('model=');
  });
  it('deduplicates presets by the request they fill, including omitted models', () => {
    const { data, job, node } = fixture();
    data.nodes = [node];
    data.jobs = [
      { ...job, id: 'unlisted', gpu_type: 'unlisted' },
      { ...job, id: 'multi', gpu_type: 'A100,H100' },
      { ...job, id: 'unknown', gpu_type: null },
      { ...job, id: 'known', gpu_type: 'A100' },
      { ...job, id: 'known-again', gpu_type: 'A100' },
    ];
    data.recent_failures = [];
    expect(planPresets(data).map((item) => item.id)).toEqual(['unlisted', 'known']);
  });
  it('orders by submission or failure end time, falling back to observation time', () => {
    const { data, job } = fixture();
    const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    data.jobs = [
      { ...job, id: 'old', submitted_at: at(1), observed_at: at(30) },
      { ...job, id: 'recent', submitted_at: at(8), observed_at: at(30) },
      { ...job, id: 'observed', submitted_at: null, observed_at: at(6), gpu_count: 2 },
    ];
    data.recent_failures = [
      {
        ...job,
        id: 'ended',
        state: 'FAILED',
        submitted_at: at(1),
        ended_at: at(9),
        end: at(2),
        observed_at: at(30),
        gpu_count: 3,
        exit_code: null,
      },
      {
        ...job,
        id: 'end',
        state: 'FAILED',
        ended_at: null,
        end: at(7),
        observed_at: at(30),
        gpu_count: 5,
        exit_code: null,
      },
    ];
    expect(planPresets(data).map((item) => item.id)).toEqual([
      'ended',
      'recent',
      'end',
      'observed',
    ]);
    data.jobs = [];
    data.recent_failures[0] = {
      ...data.recent_failures[0],
      ended_at: 'invalid',
      end: null,
      submitted_at: at(1),
      observed_at: at(10),
    };
    expect(planPresets(data).map((item) => item.id)).toEqual(['ended', 'end']);
  });
  it('offers at most four distinct positive GPU shapes from own jobs and recent failures', () => {
    const { data, job } = fixture();
    data.jobs = [
      job,
      { ...job, id: 'duplicate' },
      { ...job, gpu_count: null },
      { ...job, gpu_count: 0 },
      { ...job, user: 'someone', gpu_count: 100 },
    ];
    data.recent_failures = [1, 2, 3, 5, 6].map((count) => ({
      ...job,
      id: String(count),
      state: 'FAILED',
      observed_at: job.submitted_at ?? job.observed_at,
      gpu_count: count,
      end: null,
      exit_code: null,
    }));
    expect(planPresets(data).map((item) => item.gpu_count)).toEqual([4, 1, 2, 3]);
  });
});
