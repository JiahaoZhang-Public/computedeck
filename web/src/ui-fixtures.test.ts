import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('uses the launcher demo clock instead of a second fixed date', async () => {
  vi.stubEnv('COMPUTEDECK_DEMO_NOW', '2026-02-20T09:30:00Z');
  const { demoNow } = await import('../e2e/fixtures');
  expect(demoNow).toBe('2026-02-20T09:30:00Z');
});

it('rejects a missing demo clock before collecting browser tests', async () => {
  vi.stubEnv('COMPUTEDECK_DEMO_NOW', undefined);
  await expect(import('../e2e/fixtures')).rejects.toThrow('COMPUTEDECK_DEMO_NOW is required');
});
