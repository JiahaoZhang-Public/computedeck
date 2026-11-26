import { expect, it } from 'vitest';
import { statusKind, statusKindLabel, sourceState } from './labels';
import { setLocale, t } from './i18n';
import { serverDemo } from './test-server';
it.each([
  ['RUNNING', 'ok'],
  ['PENDING', 'wait'],
  ['HELD', 'warn'],
  ['held', 'ok'],
  ['FAILED', 'error'],
  ['TIMEOUT', 'error'],
  ['COMPLETED', 'ok'],
  ['CONFIGURING', 'wait'],
  ['disabled', 'off'],
  ['paused', 'off'],
  ['stale', 'unknown'],
  ['syncing', 'wait'],
  ['error', 'error'],
  ['desired_running', 'wait'],
  ['reported_running', 'ok'],
  ['released', 'off'],
  ['unavailable', 'error'],
  ['usable', 'ok'],
  ['degraded', 'warn'],
  ['unknown', 'unknown'],
  ['on', 'ok'],
  ['available', 'wait'],
  ['needs_setup', 'warn'],
  ['failing', 'error'],
  ['incompatible', 'unknown'],
  ['off', 'off'],
  ['bad', 'error'],
  ['ok', 'ok'],
  ['warn', 'warn'],
  ['future-state', 'unknown'],
])('%s uses the %s shape', (state, kind) => expect(statusKind(state)).toBe(kind));
it('maps disabled sources and localizes waiting distinctly from unknown', () => {
  const source = { ...serverDemo().sources[0], enabled: false };
  expect(statusKind(sourceState(source))).toBe('off');
  for (const locale of ['en', 'zh-CN'] as const) {
    setLocale(locale);
    expect(statusKindLabel('PENDING')).toBe(t('display.status.wait'));
    expect(statusKindLabel('stale')).not.toBe(t('display.status.wait'));
  }
  setLocale('en');
});
