// @vitest-environment jsdom
import type { Page, TestInfo } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import { settledScreenshot, withScreenshotViewport } from '../e2e/screenshots';

function captures(images: string[]) {
  const screenshot = vi.fn();
  for (const image of images) screenshot.mockResolvedValueOnce(Buffer.from(image));
  const page = { screenshot, locator: vi.fn() } as unknown as Page;
  const attach = vi.fn();
  const testInfo = { attach, project: { use: { hasTouch: false } } } as unknown as TestInfo;
  return { page, testInfo, screenshot, attach };
}

it('accepts two consecutive byte-identical captures', async () => {
  const { page, testInfo, screenshot } = captures(['stable', 'stable']);
  expect(await settledScreenshot(page, testInfo, 'first')).toEqual(Buffer.from('stable'));
  expect(screenshot).toHaveBeenCalledTimes(2);
});

it('discards a single torn capture before comparing contexts', async () => {
  const { page, testInfo, screenshot } = captures(['torn', 'stable', 'stable']);
  expect(await settledScreenshot(page, testInfo, 'second')).toEqual(Buffer.from('stable'));
  expect(screenshot).toHaveBeenCalledTimes(3);
});

it('fails after five captures without a consecutive match and attaches the last pair', async () => {
  const { page, testInfo, screenshot, attach } = captures(['a', 'b', 'a', 'b', 'a']);
  await expect(settledScreenshot(page, testInfo, 'first')).rejects.toThrow(
    'did not settle after 5 captures',
  );
  expect(screenshot).toHaveBeenCalledTimes(5);
  expect(attach.mock.calls.map(([, options]) => options.body)).toEqual([
    Buffer.from('b'),
    Buffer.from('a'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(touch = true) {
  let viewport = { width: touch ? 375 : 900, height: 800 };
  const queries = ['(pointer: coarse)', '(hover: none)'].map((media) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    return {
      media,
      matches: touch,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      listeners,
    };
  });
  vi.stubGlobal('matchMedia', (media: string) => queries.find((query) => query.media === media)!);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('scrollX', 0);
  vi.stubGlobal('scrollY', 240);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {
    vi.stubGlobal('scrollY', 0);
  });
  const height = vi
    .spyOn(document.documentElement, 'scrollHeight', 'get')
    .mockImplementation(() => (viewport.height === 800 ? 1000 : 1200));
  vi.spyOn(document.body, 'scrollHeight', 'get').mockReturnValue(0);
  const mask = { count: async () => 0 };
  const page = {
    viewportSize: () => ({ ...viewport }),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = { ...size };
    }),
    evaluate: vi.fn(async (fn: () => unknown) => fn()),
    locator: vi.fn(() => mask),
    screenshot: vi.fn<Page['screenshot']>().mockResolvedValue(Buffer.from('same image')),
  };
  const info = {
    project: { use: { hasTouch: touch } },
    attach: vi.fn<TestInfo['attach']>().mockResolvedValue(undefined),
  };
  return {
    page,
    info,
    height,
    mask,
    queries,
    browserPage: page as unknown as Page,
    testInfo: info as unknown as TestInfo,
  };
}

it('grows and re-measures touch captures, scrolls to top and restores the viewport', async () => {
  const { page, browserPage, testInfo, queries, mask } = setup();
  const result = await withScreenshotViewport(browserPage, testInfo, async (options) => {
    expect(options).toEqual({
      fullPage: false,
      animations: 'disabled',
      mask: [mask],
      maskColor: '#808080',
    });
    expect(page.viewportSize()).toEqual({ width: 375, height: 1200 });
    expect(window.scrollY).toBe(0);
    expect(queries.every(({ listeners }) => listeners.size === 1)).toBe(true);
    return 'captured';
  });
  expect(result).toBe('captured');
  expect(page.setViewportSize.mock.calls.map(([size]) => size.height)).toEqual([1000, 1200, 800]);
  expect(page.viewportSize()).toEqual({ width: 375, height: 800 });
  expect(queries.every(({ listeners }) => listeners.size === 0)).toBe(true);
});

it('restores touch viewport and removes guards when capture or comparison fails', async () => {
  const { browserPage, testInfo, page, queries } = setup();
  await expect(
    withScreenshotViewport(browserPage, testInfo, async () => {
      throw new Error('comparison failed');
    }),
  ).rejects.toThrow('comparison failed');
  expect(page.viewportSize()).toEqual({ width: 375, height: 800 });
  expect(queries.every(({ listeners }) => listeners.size === 0)).toBe(true);
});

it.each(['(pointer: coarse)', '(hover: none)'])(
  'fails even when %s flips back before capture ends',
  async (media) => {
    const { browserPage, testInfo, page, queries } = setup();
    const query = queries.find((item) => item.media === media)!;
    page.screenshot.mockImplementation(async () => {
      for (const matches of [false, true])
        query.listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
      return Buffer.from('same image');
    });
    await expect(settledScreenshot(browserPage, testInfo, 'media')).rejects.toThrow(
      'Pointer/hover media changed',
    );
    expect(page.viewportSize().height).toBe(800);
    expect(queries.every(({ listeners }) => listeners.size === 0)).toBe(true);
  },
);

it('fails rather than cropping a document whose height keeps growing', async () => {
  const { browserPage, testInfo, page, height } = setup();
  height.mockImplementation(() => page.viewportSize().height + 100);
  const capture = vi.fn(async () => {});
  await expect(withScreenshotViewport(browserPage, testInfo, capture)).rejects.toThrow(
    'height did not settle',
  );
  expect(capture).not.toHaveBeenCalled();
  expect(page.viewportSize().height).toBe(800);
});

it('leaves non-touch fullPage options, viewport and scroll untouched', async () => {
  const { browserPage, testInfo, page, mask } = setup(false);
  await withScreenshotViewport(browserPage, testInfo, async (options) => {
    expect(options).toEqual({
      fullPage: true,
      animations: 'disabled',
      mask: [mask],
      maskColor: '#808080',
    });
  });
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.setViewportSize).not.toHaveBeenCalled();
  expect(window.scrollY).toBe(240);
});

it('still requires two consecutive byte-identical images', async () => {
  const { browserPage, testInfo, page } = setup();
  page.screenshot
    .mockResolvedValueOnce(Buffer.from('first'))
    .mockResolvedValue(Buffer.from('settled'));
  expect(await settledScreenshot(browserPage, testInfo, 'settle')).toEqual(Buffer.from('settled'));
  expect(page.screenshot).toHaveBeenCalledTimes(3);
  expect(page.screenshot.mock.calls.every(([options]) => options?.fullPage === false)).toBe(true);
  expect(page.viewportSize().height).toBe(800);
});

it('fails after five unsettled captures and preserves both diagnostic images', async () => {
  const { browserPage, testInfo, page, info } = setup();
  let index = 0;
  page.screenshot.mockImplementation(async () => Buffer.from(String(index++)));
  await expect(settledScreenshot(browserPage, testInfo, 'unstable')).rejects.toThrow(
    'did not settle after 5 captures',
  );
  expect(page.screenshot).toHaveBeenCalledTimes(5);
  expect(info.attach.mock.calls.map(([name]) => name)).toEqual([
    'unstable-unsettled-previous',
    'unstable-unsettled-current',
  ]);
  expect(page.viewportSize().height).toBe(800);
});
