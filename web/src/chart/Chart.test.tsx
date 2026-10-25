// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
import { chartFixture } from './test-data';
import { setLocale, t } from '../i18n';

const container = document.createElement('div');
const root = createRoot(container);
const start = Date.parse('2026-01-15T12:00:00Z');
function data() {
  return chartFixture(
    Array.from({ length: 48 }, (_, i) => ({
      at: new Date(start + i * 300000).toISOString(),
      allocated_gpus: i,
      gpu_utilization: i,
      coverage_count: 1,
    })),
    '2026-01-15T16:00:00Z',
  );
}
beforeEach(() => {
  document.body.append(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => root.render(null));
  container.remove();
  setLocale('en');
  vi.unstubAllGlobals();
});
const plot = () => container.querySelector<HTMLDivElement>('.chart-plot')!;
const pin = () => container.querySelector('.chart-readout')!.getAttribute('data-pinned');
const readout = () => container.querySelector('.chart-readout')!.textContent;
async function key(key: string, options: KeyboardEventInit = {}) {
  await act(async () =>
    plot().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options })),
  );
}
describe.each(['en', 'zh-CN'] as const)('chart input %s', (locale) => {
  beforeEach(() => setLocale(locale));
  it('uses one plot tab stop, bucket/tick jumps, series keys, pin, Escape and range keys', async () => {
    const onRange = vi.fn();
    await act(async () => root.render(<Chart data={data()} onRange={onRange} />));
    expect(container.querySelectorAll('.chart-plot[tabindex="0"]')).toHaveLength(1);
    await key('Home');
    await key('ArrowRight', { shiftKey: true });
    await key('Enter');
    expect(pin()).toBe('true');
    let link = container.querySelector<HTMLAnchorElement>('a')!;
    expect(new URLSearchParams(link.hash.split('?')[1]).get('from')).toBe(
      new Date(start + 10 * 300000).toISOString(),
    );
    await key('PageDown');
    await key('ArrowDown');
    link = container.querySelector('a')!;
    expect(new URLSearchParams(link.hash.split('?')[1]).get('from')).toBe(
      new Date(start + 22 * 300000).toISOString(),
    );
    expect(container.querySelector('[data-active="true"]')!.textContent).toContain(
      t('chart.allocated'),
    );
    await key('PageUp');
    await key('ArrowLeft');
    await key('ArrowUp');
    expect(container.querySelector('[data-active="true"]')!.textContent).toContain(
      t('chart.utilization'),
    );
    await key('Escape');
    expect(pin()).toBe('false');
    await key('End');
    await key('Enter');
    expect(new URLSearchParams(container.querySelector('a')!.hash.split('?')[1]).get('from')).toBe(
      new Date(start + 47 * 300000).toISOString(),
    );
    for (const digit of ['1', '2', '3']) await key(digit);
    expect(onRange.mock.calls).toEqual([['24h'], ['7d'], ['30d']]);
    await key('1', { isComposing: true });
    await key('2', { ctrlKey: true });
    expect(onRange).toHaveBeenCalledTimes(3);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    plot().dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });
  it('pins on tap, toggles on second tap and never scrubs or replaces a pinned readout on hover', async () => {
    await act(async () => root.render(<Chart data={data()} />));
    plot().getBoundingClientRect = () => ({ left: 0, width: 760 }) as DOMRect;
    await act(async () =>
      plot().dispatchEvent(new MouseEvent('click', { clientX: 240, bubbles: true })),
    );
    expect(pin()).toBe('true');
    const pinned = readout();
    const move = new MouseEvent('pointermove', { clientX: 500, bubbles: true });
    Object.defineProperty(move, 'pointerType', { value: 'mouse' });
    await act(async () => plot().dispatchEvent(move));
    expect(readout()).toBe(pinned);
    await act(async () =>
      plot().dispatchEvent(new MouseEvent('click', { clientX: 240, bubbles: true })),
    );
    expect(pin()).toBe('false');
    const unpinned = readout();
    const touch = new MouseEvent('pointermove', { clientX: 500, bubbles: true });
    Object.defineProperty(touch, 'pointerType', { value: 'touch' });
    await act(async () => plot().dispatchEvent(touch));
    expect(readout()).toBe(unpinned);
    await act(async () =>
      plot().dispatchEvent(
        new MouseEvent('pointerdown', { clientX: 240, clientY: 40, bubbles: true }),
      ),
    );
    const drag = new MouseEvent('pointermove', {
      clientX: 500,
      clientY: 40,
      buttons: 1,
      bubbles: true,
    });
    Object.defineProperty(drag, 'pointerType', { value: 'touch' });
    await act(async () => plot().dispatchEvent(drag));
    await act(async () =>
      plot().dispatchEvent(new MouseEvent('click', { clientX: 500, bubbles: true })),
    );
    expect(pin()).toBe('false');
    expect(readout()).toBe(unpinned);
  });
  it('retains the pinned timestamp across changed data, and pages the same buckets in the table', async () => {
    const original = data();
    await act(async () => root.render(<Chart data={original} />));
    await key('Home');
    await key('Enter');
    const href = container.querySelector('a')!.href;
    const changed = structuredClone(original);
    changed.series[0].buckets[47].value = 99;
    await act(async () => root.render(<Chart data={changed} />));
    expect(pin()).toBe('true');
    expect(container.querySelector('a')!.href).toBe(href);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click(),
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(24);
    expect(container.querySelector('tbody')!.textContent).toContain(
      t('chart.sources', { known: 2, total: 2 }),
    );
    const next = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === t('chart.next'),
    )!;
    await act(async () => next.click());
    expect(container.querySelectorAll('tbody tr')).toHaveLength(24);
    expect(container.querySelector('tbody')!.textContent).toContain('99');
  });
});

it('lets unpinned Escape bubble, but consumes Escape when it unpins a reading', async () => {
  const bubbled = vi.fn();
  window.addEventListener('keydown', bubbled);
  try {
    await act(async () => root.render(<Chart data={data()} />));
    const unpinned = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => plot().dispatchEvent(unpinned));
    expect(unpinned.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
    await key('Enter');
    bubbled.mockClear();
    const pinned = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => plot().dispatchEvent(pinned));
    expect(pinned.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(pin()).toBe('false');
  } finally {
    window.removeEventListener('keydown', bubbled);
  }
});

it('measures the plot in CSS pixels, keeps three y labels per plot, and disconnects its observer', async () => {
  let resize!: ResizeObserverCallback;
  const observe = vi.fn(),
    disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  await act(async () => root.render(<Chart data={data()} />));
  expect(observe).toHaveBeenCalledWith(plot());
  await act(async () =>
    resize([{ contentRect: { width: 320 } } as ResizeObserverEntry], {} as ResizeObserver),
  );
  for (const svg of container.querySelectorAll('svg')) {
    expect(svg.getAttribute('viewBox')).toBe('0 0 320 120');
    expect(svg.getAttribute('preserveAspectRatio')).not.toBe('none');
    expect(svg.querySelectorAll('.bucket-axis')).toHaveLength(3);
  }
  expect(container.querySelectorAll('.bucket-axis')).toHaveLength(6);
  expect(container.querySelector('pattern')!.getAttribute('patternTransform')).toBe('rotate(135)');
  expect(container.querySelectorAll('.bucket-partial')).toHaveLength(0);
  expect(container.querySelectorAll('[data-lower-bound=false][stroke-dasharray]')).toHaveLength(0);
  await act(async () => root.render(null));
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it('exposes the full local time and zone through the readout Time disclosure', async () => {
  await act(async () => root.render(<Chart data={data()} />));
  const disclosure = container.querySelector<HTMLSpanElement>('.chart-readout .time-disclosure')!;
  expect(disclosure.hidden).toBe(true);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.chart-readout button[aria-expanded]')!.click(),
  );
  expect(disclosure.hidden).toBe(false);
  expect(disclosure.textContent).toContain('2026');
  expect(
    container.querySelector('.chart-readout button[aria-expanded]')!.getAttribute('aria-expanded'),
  ).toBe('true');
});
