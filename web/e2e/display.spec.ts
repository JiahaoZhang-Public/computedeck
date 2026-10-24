import AxeBuilder from '@axe-core/playwright';
import { test, expect, ready, demoNow } from './fixtures';
import { withScreenshotViewport } from './screenshots';
import { checkLayout } from './checks';

for (const forcedColors of ['none', 'active'] as const) {
  test(`display shapes survive grayscale and forced colours ${forcedColors}`, async ({
    page,
    hasTouch,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors });
    await page.goto('/?demo=true#/__gallery');
    await ready(page);
    const samples = page.locator('.shape-gallery');
    await expect(samples.locator('svg')).toHaveCount(48);
    const caption = samples.locator('h3.gallery-caption');
    await expect(caption).toBeVisible();
    await expect(caption).toHaveCSS('font-size', '12px');
    const captionStart = await caption.evaluate(
      (node) =>
        node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingInlineStart),
    );
    const rowStart = await samples.locator('.grayscale .gallery-row > span').first().boundingBox();
    expect(captionStart).toBe(rowStart!.x);
    if (hasTouch) {
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const summary = page.locator('.how-worked-out > summary');
      await expect(summary).toHaveCSS('display', 'list-item');
      expect(await summary.evaluate((node) => getComputedStyle(node).listStyleType)).not.toBe(
        'none',
      );
      const target = await summary.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('[data-static-sample]')).toHaveCount(1);
    await expect(page.locator('[data-static-sample] [aria-busy=true]')).toHaveCount(1);
    const marks = page.locator('.identity-monogram');
    expect(new Set(await marks.allTextContents()).size).toBe(6);
    const fits = await marks.evaluateAll((nodes) =>
      nodes.every((node) => node.scrollWidth <= node.clientWidth),
    );
    expect(fits).toBe(true);
    const sizes = await samples.locator('.shape-samples.normal svg').evaluateAll((nodes) =>
      nodes.map((node) => ({
        kind: node.closest('[data-kind]')!.getAttribute('data-kind'),
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      })),
    );
    for (const shape of sizes) {
      expect(shape.width).toBeGreaterThanOrEqual(shape.kind === 'unknown' ? 12 : 10);
      expect(shape.height).toBe(shape.width);
    }
    await withScreenshotViewport(page, testInfo, (options) =>
      expect(page).toHaveScreenshot(`display-${forcedColors}.png`, options),
    );
    const results = await new AxeBuilder({ page })
      .include('.gallery')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('status outlines remain distinct when rasterised at ten pixels in grayscale', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  const differences = await page
    .locator('.shape-samples.normal [data-size="10"] svg')
    .evaluateAll(async (nodes) => {
      const rasters = await Promise.all(
        nodes.map(async (node) => {
          const svg = node.cloneNode(true) as SVGElement;
          svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          svg.setAttribute('width', '10');
          svg.setAttribute('height', '10');
          svg.removeAttribute('style');
          svg.removeAttribute('class');
          svg.style.color = 'black';
          const image = new Image();
          image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 10;
          const ctx = canvas.getContext('2d')!;
          ctx.filter = 'grayscale(1)';
          ctx.drawImage(image, 0, 0, 10, 10);
          return ctx.getImageData(0, 0, 10, 10).data;
        }),
      );
      return rasters.flatMap((a, i) =>
        rasters.slice(i + 1).map((b, j) => ({
          pair: [
            nodes[i].closest('[data-kind]')!.getAttribute('data-kind'),
            nodes[i + j + 1].closest('[data-kind]')!.getAttribute('data-kind'),
          ],
          pixels: Array.from(
            { length: 100 },
            (_, k) => Math.abs(a[k * 4 + 3] - b[k * 4 + 3]) / 255,
          ).reduce((sum, n) => sum + n, 0),
        })),
      );
    });
  expect(differences).toHaveLength(15);
  expect(
    differences.filter(({ pixels }) => !(pixels >= 8)),
    `All shape differences (minimum 8 pixels): ${JSON.stringify(differences, null, 2)}`,
  ).toEqual([]);
});

test('time disclosures support Enter, Space and Escape and describe collapsed row links', async ({
  page,
  hasTouch,
}) => {
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  const time = page.locator('.display-time').first();
  const button = time.getByRole('button');
  const disclosure = time.locator('.time-disclosure');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAttribute(
    'aria-controls',
    (await disclosure.getAttribute('id')) as string,
  );
  await expect(disclosure).toBeHidden();
  await expect(
    page.locator('a[aria-describedby="gallery-time-description"]'),
  ).toHaveAccessibleDescription(new RegExp(String(new Date(demoNow).getUTCFullYear())));
  for (const key of ['Enter', 'Space']) {
    await button.focus();
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText(String(new Date(demoNow).getUTCFullYear()));
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure).toBeHidden();
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(disclosure).toBeHidden();
    await expect(button).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  if (hasTouch) {
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await button.click();
  await expect(disclosure).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(disclosure).toBeHidden();
});

test('clock choice persists across routes and reloads', async ({ page, locale }) => {
  await page.goto('/?demo=true#/settings');
  await ready(page);
  await page.locator('#appearance-clock').selectOption('12');
  await page.reload();
  await ready(page);
  await expect(page.locator('#appearance-clock')).toHaveValue('12');
  const at = new Date(Date.parse(demoNow) - 120000);
  for (const clock of ['12', '24']) {
    await page.goto('/?demo=true#/settings');
    await ready(page);
    await page.locator('#appearance-clock').selectOption(clock);
    await page.goto('/?demo=true#/__gallery');
    await ready(page);
    await expect(page.locator('.scope-line time')).toHaveText(
      new Intl.DateTimeFormat(locale, {
        hour12: clock === '12',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(at),
    );
  }
});

test('copy is local, announced, and includes the example marker', async ({ page }) => {
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copied = text;
        },
      },
    });
  });
  await page.locator('.display-copy button').click();
  await expect(page.locator('.display-copy [role=status]')).not.toBeEmpty();
  await expect(page.locator('body')).toHaveAttribute(
    'data-copied',
    'squeue --me --start -j 48213\n# example data',
  );
  await expect(page.locator('.display-copy [role=status]')).toBeEmpty({ timeout: 4000 });
});

test('display gallery controls fit the viewport and meet touch targets, collapsed and expanded', async ({
  page,
  hasTouch,
}) => {
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  if (hasTouch)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await expect(page.locator('.display-row-link')).toHaveCount(1);
  expect(await checkLayout(page)).toEqual([]);
  await page.locator('.how-worked-out > summary').click();
  for (const button of await page.locator('.gallery .display-time > button').all()) {
    await expect(button).toBeVisible();
    await button.click();
  }
  // Includes the disclosed rule's Time button as well as copy, Clear and first-use links.
  expect(await checkLayout(page)).toEqual([]);
  const results = await new AxeBuilder({ page })
    .include('.gallery')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
