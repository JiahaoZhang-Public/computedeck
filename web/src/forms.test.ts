import { describe, expect, it } from 'vitest';
import { checkFinished, checklist } from './sourceCheck';
import { qosGpuLimit } from './domain';
import { driverInfo, fieldValue, primaryField, sortDrivers } from './drivers';
import type { DriverInfo, Source } from './types';

const check = (capability: string, command: string, label: string, warning: string | null) => ({
  capability,
  command,
  label: { en: label },
  warning,
});
// Mirrors the description the Slurm driver serves from /api/drivers.
const SLURM: DriverInfo = {
  ...driverInfo([], 'slurm'),
  label: { en: 'Slurm cluster' },
  fields: [
    {
      key: 'username',
      label: { en: 'Login username' },
      hint: {},
      placeholder: 'alice',
      default: '',
      required: true,
      pattern: null,
      choices: null,
      identity: true,
    },
  ],
  checks: [
    check('jobs', 'squeue', 'Your jobs (squeue)', null),
    check('nodes', 'scontrol', 'Visible nodes (scontrol)', 'nodes_unavailable'),
    check('qos_limits', 'assoc_mgr', 'QoS limits', 'qos_unavailable'),
    check('history', 'sacct', 'Failures (sacct)', 'history_unavailable'),
  ],
};

const source = (extra: Partial<Source>): Source => ({
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
  last_success: null,
  last_attempt: null,
  error: null,
  interval_minutes: 10,
  capabilities: [],
  qos: [],
  ...extra,
});

describe('first collection check', () => {
  it('waits until the collector has attempted the new source', () => {
    expect(checkFinished(source({}))).toBe(false);
    expect(checkFinished(source({ last_attempt: '2026-01-01T00:00:00Z', status: 'syncing' }))).toBe(
      false,
    );
    expect(checklist(source({}), SLURM).every((row) => row.state === 'pending')).toBe(true);
  });
  it('marks optional capabilities that the cluster did not allow', () => {
    const rows = checklist(
      source({
        last_attempt: '2026-01-01T00:00:00Z',
        last_success: '2026-01-01T00:00:01Z',
        capabilities: ['jobs', 'nodes'],
        warnings: [{ code: 'history_unavailable', detail: 'sacct: disabled' }],
      }),
      SLURM,
    );
    expect(rows.map((row) => row.state)).toEqual(['ok', 'ok', 'ok', 'missing', 'missing']);
    expect(rows[4].detail).toBe('Failure history unavailable: sacct: disabled');
  });
  it('reports a failed connection and skips the remaining checks', () => {
    const rows = checklist(
      source({
        status: 'error',
        last_attempt: '2026-01-01T00:00:00Z',
        error: { code: 'ssh_failed', detail: 'Host key verification failed.' },
      }),
      SLURM,
    );
    expect(rows[0]).toMatchObject({ state: 'failed' });
    expect(rows[0].detail).toContain('Host key verification failed.');
    expect(rows.slice(1).every((row) => row.state === 'skipped')).toBe(true);
  });
});

describe('driver descriptions', () => {
  it('orders well-known drivers first and keeps unknown ones', () => {
    const names = sortDrivers(
      ['zeta', 'runpod', 'aws-ec2', 'slurm'].map((name) => driverInfo([], name)),
    ).map((info) => info.name);
    expect(names).toEqual(['slurm', 'runpod', 'aws-ec2', 'zeta']);
  });
  it('falls back to a minimal description for an unknown driver', () => {
    const info = driverInfo([], 'custom', 'cloud');
    expect(info).toMatchObject({ name: 'custom', kind: 'cloud', label: { en: 'custom' } });
    expect(primaryField(info)).toBeUndefined();
  });
  it('reads common fields from the source and others from its options', () => {
    const item = source({ options: { namespace: 'ml-team' } });
    expect(primaryField(SLURM)?.key).toBe('username');
    expect(fieldValue(item, 'username')).toBe('alice');
    expect(fieldValue(item, 'namespace')).toBe('ml-team');
    expect(fieldValue(source({}), 'context')).toBe('');
  });
});

describe('QoS GPU limits', () => {
  it('reads the per-user GPU limit and ignores other TRES', () => {
    const qos = (MaxTRESPU?: string) => ({
      name: 'normal',
      origin: 'test',
      limits: MaxTRESPU === undefined ? {} : ({ MaxTRESPU } as Record<string, string>),
    });
    expect(qosGpuLimit(qos('cpu=64,gres/gpu=8'))).toBe(8);
    expect(qosGpuLimit(qos('gres/gpu:a100=4'))).toBeNull();
    expect(qosGpuLimit(qos('gres/gpu:a100=4'), 'a100')).toBe(4);
    // No GPU entry, or gres/gpu=N, means the QoS sets no GPU limit.
    expect(qosGpuLimit(qos('cpu=64'))).toBe(Infinity);
    expect(qosGpuLimit(qos('cpu=N,gres/gpu=N,gres/gpumem=N'))).toBe(Infinity);
    expect(qosGpuLimit(qos('gres/gpu=64,gres/gpu:mi210=N'))).toBe(64);
    expect(qosGpuLimit(qos())).toBeNull();
  });
});
