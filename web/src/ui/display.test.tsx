// @vitest-environment jsdom
import { act, Profiler, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '../i18n';
import { serverDemo } from '../test-server';
import { Status as LegacyStatus } from '../ui';
import { Status, StatusShape } from './Status';
import { shapes } from './shapes';
import type { StatusKind } from './shapes';
import { Value } from './Value';
import { Time, Age } from './Time';
import { CopyButton } from './CopyButton';
import { DataState } from './DataState';
import { HowWorkedOut } from './ScopeLine';
import { DisplayGallery } from './DisplayGallery';
import { Monogram } from './Identity';
import { ScopeLine } from './ScopeLine';
import { saveClock, clockTime } from '../format';
import { useClock } from './clock';

const container = document.createElement('div');
const root = createRoot(container);
const example = serverDemo().display_example!;
beforeEach(() => {
  document.body.append(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => root.render(null));
  container.remove();
  setLocale('en');
  saveClock('24');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['en', 'zh-CN'] as const)('display primitives %s', (language) => {
  beforeEach(() => setLocale(language));
  it('renders six SVG shapes, clamps their size and prefixes severity without changing legacy DOM', async () => {
    await act(async () =>
      root.render(
        <>
          {(Object.keys(shapes) as StatusKind[]).map((kind) => (
            <Status kind={kind} key={kind} />
          ))}
          <StatusShape kind="unknown" size={8} />
          <LegacyStatus state="FAILED" />
        </>,
      ),
    );
    expect(container.querySelectorAll('.display-status svg')).toHaveLength(6);
    expect(container.querySelector('.severity-error .sr-only')?.textContent).toContain(
      t('display.errorPrefix'),
    );
    expect(container.querySelector('.severity-warn .sr-only')?.textContent).toContain(
      t('display.warnPrefix'),
    );
    expect(container.querySelector<SVGElement>(':scope > svg')!.style.width).toBe('12px');
    expect(container.querySelector('.status')?.innerHTML).toBe(`<i></i>${t('status.FAILED')}`);
  });
  it('names standalone shapes and leaves unlabelled shapes decorative', async () => {
    await act(async () =>
      root.render(
        <>
          {(Object.keys(shapes) as StatusKind[]).map((kind) => (
            <StatusShape key={kind} kind={kind} label={t(`display.status.${kind}`)} />
          ))}
          <StatusShape kind="warn" />
        </>,
      ),
    );
    const named = container.querySelectorAll('[role=img]');
    expect(named).toHaveLength(6);
    for (const [index, kind] of (Object.keys(shapes) as StatusKind[]).entries()) {
      const prefix = kind === 'error' || kind === 'warn' ? `${t(`display.${kind}Prefix`)} ` : '';
      expect(named[index].getAttribute('aria-label')).toBe(prefix + t(`display.status.${kind}`));
      expect(named[index].hasAttribute('aria-hidden')).toBe(false);
    }
    const decorative = container.querySelector('svg:last-child')!;
    expect(decorative.getAttribute('aria-hidden')).toBe('true');
    expect(decorative.hasAttribute('aria-label')).toBe(false);
    expect(decorative.hasAttribute('role')).toBe(false);
  });
  it('keeps time disclosures phrasing-only and row descriptions available while collapsed', async () => {
    const time = <Time value={example.at} descriptionId="row-time" />;
    await act(async () => root.render(<p>{time}</p>));
    const button = container.querySelector('button')!;
    const disclosure = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.hidden).toBe(true);
    expect(container.querySelector('#row-time')?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('#row-time')?.textContent).toContain('2026');
    // Native button Enter/Space activation dispatches click; Playwright checks the keys.
    button.focus();
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure.hidden).toBe(false);
    await act(async () =>
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const parsed = document.createElement('div');
    await act(async () =>
      root.render(
        <>
          <ScopeLine scope="Mine" groups="All" asOf={example.at} />
          <Value value={2} kind="lastKnown" at={example.at} reason="old" />
          <DataState state="stale" reason="old" at={example.at} />
        </>,
      ),
    );
    parsed.innerHTML = container.innerHTML;
    expect(parsed.querySelector('p.scope-line .display-time button')).not.toBeNull();
    expect(parsed.querySelector('span.display-value .display-time button')).not.toBeNull();
    expect(parsed.querySelector('.data-state p .display-time button')).not.toBeNull();
    expect(parsed.querySelector('details')).toBeNull();
  });
  it('shows distinct two-letter or explicit monograms with the full accessible name', async () => {
    await act(async () =>
      root.render(
        <>
          <Monogram slot={1} label="Cluster A" />
          <Monogram slot={1} label="Cluster B" />
          <Monogram label={t('nav.clusters')} initial="C3" />
        </>,
      ),
    );
    const marks = [...container.querySelectorAll('[role=img]')];
    expect(marks.map((node) => node.textContent)).toEqual(['CA', 'CB', 'C3']);
    expect(marks.map((node) => node.getAttribute('aria-label'))).toEqual([
      'Cluster A',
      'Cluster B',
      t('nav.clusters'),
    ]);
  });
  it('shows a real age for data under one minute old', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T14:00:00Z'));
    await act(async () =>
      root.render(<Age label={t('clusters.nodes')} value="2026-01-15T13:59:30Z" />),
    );
    expect(container.textContent).toContain(t('cost.duration.minutes', { count: 0 }));
  });
  it('marks bounds, estimates, unknowns, last-known values and stale exact figures', async () => {
    await act(async () =>
      root.render(
        <>
          <Value value={29} kind="lower" unit="GPU" />
          <Value value={41.2} kind="estimate" currency="USD" />
          <Value value={null} reason="missing" />
          <Value value={2} kind="lastKnown" at={example.at} reason="old" />
          <Value value={2} stale reason="late" />
          <Value value={29} kind="lower" stale />
        </>,
      ),
    );
    const values = [...container.querySelectorAll('.display-value')].map(
      (node) => node.textContent,
    );
    expect(values[0]).toBe('≥ 29 GPU');
    expect(values[1]).toContain(language === 'zh-CN' ? '≈ US$41.20' : '≈ $41.20');
    expect(values[1]).toContain(t('display.estimate'));
    expect(values[2]).toBe('— · missing');
    expect(values[3]).toContain(`${t('display.lastKnown')} 2`);
    expect(values[4]).toBe('— · late');
    expect(values[5]).toBe('≥ 29');
  });
  it('exposes the server trace and all data states in the gallery', async () => {
    await act(async () => root.render(<DisplayGallery example={example} />));
    for (const state of ['loading', 'first', 'quiet', 'filtered', 'error', 'stale'])
      expect(container.querySelector(`[data-state=${state}]`)).not.toBeNull();
    expect(container.querySelector('[data-state=loading]')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.data-skeleton')?.getAttribute('style')).toBe('height: 40px;');
    expect(container.textContent).toContain(t('msg.display_example_rule'));
    expect(container.textContent).toContain(t('msg.display_example_missing'));
    expect(container.querySelectorAll('.identity-swatch')).toHaveLength(6);
    expect(
      new Set([...container.querySelectorAll('.identity-monogram')].map((node) => node.textContent))
        .size,
    ).toBe(6);
    expect(
      container
        .querySelector('[data-state=loading]')
        ?.parentElement?.hasAttribute('data-static-sample'),
    ).toBe(true);
    expect(container.querySelector('[data-state=filtered] button')?.getAttribute('type')).toBe(
      'button',
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-state=filtered] button')!.click(),
    );
    expect(container.querySelector('[data-state=filtered]')).toBeNull();
  });
  it('keeps last data visible on error and prints the trace literally rather than recomputing it', async () => {
    await act(async () =>
      root.render(
        <>
          <DataState state="error" reason="offline" at={example.at}>
            <p>last readings</p>
          </DataState>
          <HowWorkedOut
            trace={{ rule: 'server rule', included: ['Cluster A'], excluded: [], as_of: null }}
          />
        </>,
      ),
    );
    expect(container.textContent).toContain('offline');
    expect(container.textContent).toContain('last readings');
    expect(container.textContent).toContain('server rule');
    expect(container.textContent).toContain(t('display.none'));
  });
});

it('publishes only minute boundaries and format changes, with one timer under StrictMode', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T14:00:30Z'));
  let renders = 0;
  const commits = vi.fn();
  function Snapshot() {
    return <output>{useClock()}</output>;
  }
  function Row() {
    renders++;
    return (
      <>
        <Profiler id="labels" onRender={commits}>
          <Time value="2026-01-15T13:59:00Z" relative descriptionId="absolute" />
          <Time value="2026-01-15T13:59:00Z" />
          <Age value="2026-01-15T13:59:00Z" />
          <Time value="invalid" />
          <Snapshot />
        </Profiler>
      </>
    );
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <Row />
      </StrictMode>,
    ),
  );
  expect(vi.getTimerCount()).toBe(1);
  expect(container.querySelector('output')?.textContent).toBe(
    String(Date.parse('2026-01-15T14:00:00Z')),
  );
  expect(container.textContent).toContain(t('time.minutesAgo', { count: 1 }));
  const before = renders;
  commits.mockClear();
  await act(async () => vi.advanceTimersByTime(29999));
  expect(commits).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(commits).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(t('time.minutesAgo', { count: 2 }));
  expect(container.querySelector('output')?.textContent).toBe(
    String(Date.parse('2026-01-15T14:01:00Z')),
  );
  await act(async () => vi.advanceTimersByTime(59999));
  expect(commits).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(1));
  expect(commits).toHaveBeenCalledTimes(2);
  const absolute = container.querySelectorAll('button time')[1];
  const previousTime = absolute.textContent;
  await act(async () => saveClock('12'));
  expect(commits).toHaveBeenCalledTimes(3);
  expect(absolute.textContent).toBe(clockTime(Date.parse('2026-01-15T13:59:00Z')));
  expect(absolute.textContent).not.toBe(previousTime);
  await act(async () => saveClock('12'));
  expect(commits).toHaveBeenCalledTimes(3);
  // Flush jsdom's zero-delay storage event, not a clock tick.
  await act(async () => vi.advanceTimersByTime(0));
  expect(commits).toHaveBeenCalledTimes(3);
  expect(renders).toBe(before);
  expect(container.querySelector('#absolute')?.textContent).toContain('2026');
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.render(null));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () =>
    root.render(
      <StrictMode>
        <Row />
      </StrictMode>,
    ),
  );
  expect(vi.getTimerCount()).toBe(1);
});

it.each([false, true])(
  'copies only, including example marker %s, and resets after two seconds',
  async (example) => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => root.render(<CopyButton text="squeue --me" example={example} />));
    await act(async () => container.querySelector('button')!.click());
    expect(writeText).toHaveBeenCalledWith(example ? 'squeue --me\n# example data' : 'squeue --me');
    expect(container.querySelector('[role=status]')?.textContent).toBe(t('display.copied'));
    await act(async () => vi.advanceTimersByTime(1999));
    expect(container.querySelector('[role=status]')?.textContent).toBe(t('display.copied'));
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[role=status]')?.textContent).toBe('');
  },
);
it('retains clipboard failure text and never announces success', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  await act(async () => root.render(<CopyButton text="squeue --me" />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role=status]')?.textContent).toBe(t('toast.clipboard'));
});
