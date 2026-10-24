import { afterEach, expect, it, vi } from 'vitest';
import { serverDemo } from '../test-server';
import { recentlyReachable, RECENT_MS } from './util';

afterEach(() => vi.useRealTimers());

it('uses the SSH check time rather than fresh provider listings', () => {
  vi.useFakeTimers();
  const now = Date.now();
  const item = {
    ...serverDemo().instances[0],
    ssh_status: 'reachable',
    observed_at: new Date(now).toISOString(),
  };
  for (const last_probe_attempt of [
    undefined,
    null,
    'invalid',
    new Date(now - RECENT_MS).toISOString(),
    new Date(now + RECENT_MS + 1000).toISOString(),
  ]) {
    expect(recentlyReachable({ ...item, last_probe_attempt })).toBe(false);
  }
  for (const offset of [1000, RECENT_MS - 1, RECENT_MS]) {
    expect(
      recentlyReachable({ ...item, last_probe_attempt: new Date(now + offset).toISOString() }),
    ).toBe(true);
  }
  const last_probe_attempt = new Date(now - RECENT_MS + 1).toISOString();
  expect(recentlyReachable({ ...item, last_probe_attempt })).toBe(true);
  expect(recentlyReachable({ ...item, last_probe_attempt, ssh_status: 'error' })).toBe(false);
  expect(recentlyReachable({ ...item, last_probe_attempt, observed_at: null })).toBe(true);
});
