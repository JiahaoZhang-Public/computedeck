// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourceForm } from './forms';
import { ConnectionChecks } from './ConnectionChecks';
import { api } from './api';
import { driverInfo } from './drivers';
import { groupsOf } from './groups';
import { setLocale, t } from './i18n';
import { serverDemo } from './test-server';
import { statusTone } from './labels';
import type { Source } from './types';

vi.mock('./api', () => ({ api: vi.fn(), upload: vi.fn(), download: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api).mockReset().mockResolvedValue([]);
  setLocale('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps an edited credential reference pending until a new collection finishes', async () => {
  const data = serverDemo();
  const source = { ...data.sources[0], last_attempt: '2026-01-05T10:00:00Z' };
  const saved = vi.fn(async () => source);
  const close = vi.fn();
  const info = driverInfo([], source.driver);
  info.fields = [
    {
      key: 'credential',
      label: { en: 'Credential reference' },
      hint: {},
      placeholder: '',
      default: '',
      required: false,
      pattern: null,
      choices: null,
      identity: false,
    },
  ];
  const form = (current: Source) => (
    <SourceForm
      source={source}
      sources={[current]}
      groups={groupsOf(data)}
      drivers={[info]}
      where="this service"
      busy={false}
      onSubmit={saved}
      onCancel={close}
      onManual={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  await act(async () => root.render(form(source)));
  const credential = container.querySelector<HTMLInputElement>('[name="field:credential"]')!;
  credential.value = 'keyring:example-new';
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(saved).toHaveBeenCalledWith(
    expect.objectContaining({ credential: 'keyring:example-new' }),
    source.id,
  );
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain(t('source.check.running'));
  expect(container.textContent).not.toContain(t('source.check.done'));
  await act(async () =>
    root.render(
      form({
        ...source,
        last_attempt: '2026-01-05T10:05:00Z',
        last_success: '2026-01-05T10:05:00Z',
        status: 'ready',
      }),
    ),
  );
  expect(container.textContent).toContain(t('source.check.done'));
});

it('cancels a diagnostic request when its view closes', async () => {
  vi.mocked(api).mockImplementation(() => new Promise(() => {}));
  await act(async () => root.render(<ConnectionChecks sourceId="example" />));
  const signal = vi.mocked(api).mock.calls[0][3]!.signal;
  expect(signal.aborted).toBe(false);
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});

it('does not label normal queued and starting jobs as warnings', () => {
  for (const state of ['PENDING', 'CONFIGURING', 'COMPLETING', 'syncing'])
    expect(statusTone(state)).toBe('gray');
  expect(statusTone('stale')).toBe('amber');
  expect(statusTone('FAILED')).toBe('red');
});
