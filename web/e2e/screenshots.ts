import { expect, type Page, type TestInfo } from '@playwright/test';

const addressSelector = '.page-settings .kv > div > dd.mono';
type CaptureWindow = Window & { stopScreenshotMediaGuard?: () => string[] };

function screenshotOptions(page: Page) {
  return {
    fullPage: true,
    animations: 'disabled' as const,
    // Only Settings → Service → Address: the temporary service has a random port.
    mask: [page.locator(addressSelector)],
    maskColor: '#808080',
  };
}

export async function withScreenshotViewport<T>(
  page: Page,
  testInfo: TestInfo,
  capture: (options: ReturnType<typeof screenshotOptions>) => Promise<T>,
): Promise<T> {
  const options = screenshotOptions(page);
  // Preserve the existing desktop capture path, including its scroll position.
  if (!testInfo.project.use.hasTouch) return capture(options);
  const original = page.viewportSize();
  if (!original) throw new Error('Touch screenshots require a configured viewport');
  await page.evaluate(() => {
    const queries = ['(pointer: coarse)', '(hover: none)'].map((query) => matchMedia(query));
    if (queries.some((query) => !query.matches))
      throw new Error('Touch screenshot started without coarse-pointer / no-hover media');
    const changes: string[] = [];
    const listeners = queries.map((query) => {
      const listener = (event: MediaQueryListEvent) =>
        changes.push(`${query.media}=${event.matches}`);
      query.addEventListener('change', listener);
      return listener;
    });
    (window as CaptureWindow).stopScreenshotMediaGuard = () => {
      queries.forEach((query, index) => query.removeEventListener('change', listeners[index]));
      return changes;
    };
  });
  try {
    // Chromium's fullPage path temporarily drops touch emulation. Resize explicitly instead.
    let height = original.height;
    let fitted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const needed = await page.evaluate(async () => {
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return Math.ceil(
          Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        );
      });
      if (needed <= height) {
        fitted = true;
        break;
      }
      height = needed;
      await page.setViewportSize({ width: original.width, height });
    }
    if (!fitted) throw new Error('Touch screenshot document height did not settle after resizing');
    expect(
      await page.evaluate(() => [window.scrollX, window.scrollY]),
      'Touch capture starts at the top',
    ).toEqual([0, 0]);
    return await capture({ ...options, fullPage: false });
  } finally {
    try {
      await page.setViewportSize(original);
    } finally {
      const changes = await page.evaluate(async () => {
        // Flush media events queued during capture or viewport restoration before removing listeners.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const target = window as CaptureWindow;
        const events = target.stopScreenshotMediaGuard!();
        delete target.stopScreenshotMediaGuard;
        return events;
      });
      expect(changes, 'Pointer/hover media changed during touch screenshot capture').toEqual([]);
    }
  }
}

async function checkAddressMask(page: Page, screenshot: Buffer) {
  const address = page.locator(addressSelector);
  await expect(address).toHaveCount(1);
  const box = await address.boundingBox();
  if (!box) throw new Error('Settings Address has no visible box to mask');
  const viewport = page.viewportSize()!;
  const result = await page.evaluate(
    async ({ png, box, viewport }) => {
      // Decode with the browser, without an extra PNG dependency or an attached DOM element.
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const scaleX = bitmap.width / viewport.width;
        const scaleY = bitmap.height / viewport.height;
        const left = Math.ceil(box.x * scaleX);
        const top = Math.ceil(box.y * scaleY);
        const right = Math.floor((box.x + box.width) * scaleX);
        const bottom = Math.floor((box.y + box.height) * scaleY);
        if (
          box.x < 0 ||
          box.y < 0 ||
          (box.x + box.width) * scaleX > bitmap.width ||
          (box.y + box.height) * scaleY > bitmap.height ||
          right <= left ||
          bottom <= top
        )
          return 'Address box is outside the captured image';
        const { data } = context.getImageData(left, top, right - left, bottom - top);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 128 || data[i + 1] !== 128 || data[i + 2] !== 128 || data[i + 3] !== 255)
            return `Address is not masked at pixel ${left + ((i / 4) % (right - left))},${top + Math.floor(i / 4 / (right - left))}`;
        }
        return null;
      } finally {
        bitmap.close();
      }
    },
    { png: screenshot.toString('base64'), box, viewport },
  );
  expect(result, 'The entire Settings Address box must be inside the grey mask').toBeNull();
}

export async function settledScreenshot(page: Page, testInfo: TestInfo, name: string) {
  return withScreenshotViewport(page, testInfo, async (options) => {
    let current = await page.screenshot(options);
    let previous = current;
    for (let attempt = 2; attempt <= 5; attempt++) {
      previous = current;
      current = await page.screenshot(options);
      if (current.equals(previous)) {
        if (testInfo.project.use.hasTouch && (await page.locator('.page-settings').count()))
          await checkAddressMask(page, current);
        return current;
      }
    }
    await testInfo.attach(`${name}-unsettled-previous`, {
      body: previous,
      contentType: 'image/png',
    });
    await testInfo.attach(`${name}-unsettled-current`, { body: current, contentType: 'image/png' });
    throw new Error(
      `${name}: full-page screenshot did not settle after 5 captures (two consecutive byte-identical captures required)`,
    );
  });
}
