import AxeBuilder from '@axe-core/playwright';
import { wcagTags, test, expect, ready } from './fixtures';
import { withScreenshotViewport } from './screenshots';

for (const forcedColors of ['none', 'active'] as const) {
  test(`chart kit keyboard, pin and table ${forcedColors}`, async ({
    page,
    locale,
    hasTouch,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors });
    await page.goto('/?demo=true#/usage');
    await ready(page);
    const chart = page.locator('.chart-kit');
    const plot = chart.locator('.chart-plot');
    await expect(plot).toHaveCSS('touch-action', 'pan-y');
    await expect(chart.locator('.chart-keys')).toHaveCSS(
      'position',
      hasTouch ? 'absolute' : 'static',
    );
    await expect(plot).toHaveAttribute('aria-describedby', /keys/);
    await expect(chart.locator('.chart-multiple')).toHaveCount(2);
    await expect(
      chart.getByRole('button', {
        name: locale === 'en' ? 'Previous 24 hours' : '前 24 小时',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      chart.getByRole('button', {
        name: locale === 'en' ? 'Next 24 hours' : '后 24 小时',
        exact: true,
      }),
    ).toBeDisabled();
    const bounds = await chart.boundingBox();
    const panel = await chart.evaluate((node) => {
      const box = node.closest('.panel')!.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
    expect(bounds!.x).toBeGreaterThanOrEqual(panel.left);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panel.right);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    for (const control of await chart.locator('.chart-tools button').all()) {
      const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x + 11.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 11.5);
    }
    await expect
      .poll(async () =>
        chart
          .locator('.chart-multiple svg')
          .first()
          .evaluate((svg) => {
            const view = (svg as SVGSVGElement).viewBox.baseVal;
            return Math.abs(view.width - svg.getBoundingClientRect().width);
          }),
      )
      .toBeLessThan(0.1);
    await expect(chart.locator('.bucket-axis')).toHaveCount(6);
    await expect(chart.locator('.bucket-partial')).toHaveCount(0);
    await expect(chart.locator('[data-lower-bound=false][stroke-dasharray]')).toHaveCount(0);
    expect(await chart.locator('.bucket-gap').count()).toBeGreaterThan(0);
    expect(await chart.locator('[data-lower-bound=true]').count()).toBeGreaterThan(0);
    // The key list is invisible until the plot has keyboard focus; it always describes it.
    if (!hasTouch) await expect(chart.locator('.chart-keys')).toHaveCSS('opacity', '0');
    await plot.focus();
    await plot.press('Home');
    if (!hasTouch) await expect(chart.locator('.chart-keys')).toHaveCSS('opacity', '1');
    await plot.press('Shift+ArrowRight');
    await plot.press('Enter');
    await expect(chart.locator('.chart-readout')).toHaveAttribute('data-pinned', 'true');
    const link = chart.getByRole('link');
    const href = await link.getAttribute('href');
    expect(href).toContain('from=');
    expect(href).toContain('to=');
    await plot.hover({ position: { x: 150, y: 50 } });
    await expect(link).toHaveAttribute('href', href!);
    await plot.press('Escape');
    await expect(chart.locator('.chart-readout')).toHaveAttribute('data-pinned', 'false');
    await plot.press('End');
    await plot.press('Enter');
    await page.evaluate(() => window.scrollTo(0, 0));
    await withScreenshotViewport(page, testInfo, (options) =>
      expect(page).toHaveScreenshot(`chart-${forcedColors}.png`, options),
    );
    const audit = await new AxeBuilder({ page }).include('.chart-kit').withTags(wcagTags).analyze();
    expect(audit.violations).toEqual([]);
    await chart.getByRole('button', { name: locale === 'en' ? 'Table view' : '表格视图' }).click();
    await expect(chart.locator('tbody tr')).toHaveCount(24);
    await chart
      .getByRole('button', { name: locale === 'en' ? 'Next' : '下一段', exact: true })
      .click();
    await expect(chart.locator('.chart-pages')).toContainText('2 /');
    const tableAudit = await new AxeBuilder({ page })
      .include('.chart-kit')
      .withTags(wcagTags)
      .analyze();
    expect(tableAudit.violations).toEqual([]);
  });
}

test('chart tap pins and opens the exact Activity interval', async ({ page, hasTouch }) => {
  await page.goto('/?demo=true#/usage');
  await ready(page);
  const plot = page.locator('.chart-plot');
  if (hasTouch) await plot.tap({ position: { x: 120, y: 70 } });
  else await plot.click({ position: { x: 120, y: 70 } });
  const readout = page.locator('.chart-readout');
  await expect(readout).toHaveAttribute('data-pinned', 'true');
  const href = await readout.getByRole('link').getAttribute('href');
  const params = new URLSearchParams(href!.split('?')[1]);
  const request = page.waitForRequest((req) => req.url().includes('/api/events?'));
  await readout.getByRole('link').click();
  const url = new URL((await request).url());
  expect(url.searchParams.get('since')).toBe(params.get('from'));
  expect(url.searchParams.get('until')).toBe(params.get('to'));
  expect(url.searchParams.has('range')).toBe(false);
  await ready(page);
});

test('chart range keys and previous/next windows use server buckets', async ({ page, locale }) => {
  await page.goto('/?demo=true#/usage');
  await ready(page);
  const plot = page.locator('.chart-plot');
  await plot.focus();
  const liveUrl = page.url();
  await plot.press(']');
  expect(page.url()).toBe(liveUrl);
  await expect(plot).toBeFocused();
  const back = page.waitForRequest(
    (req) => req.url().includes('/api/history?') && new URL(req.url()).searchParams.has('end'),
  );
  await plot.press('[');
  const previousEnd = new URL((await back).url()).searchParams.get('end');
  await ready(page);
  expect(previousEnd).toBeTruthy();
  expect(new URLSearchParams(page.url().split('#')[1].split('?')[1]).get('end')).toBe(previousEnd);
  await expect(plot).toBeFocused();
  await expect(page.locator('.bucket-now')).toHaveCount(0);
  const forward = page.waitForRequest(
    (req) =>
      req.url().includes('/api/history?') &&
      new URL(req.url()).searchParams.get('chart') === '1' &&
      !new URL(req.url()).searchParams.has('end'),
  );
  await plot.press(']');
  await forward;
  await ready(page);
  expect(page.url()).toBe(liveUrl);
  await expect(plot).toBeFocused();
  await expect(page.locator('.bucket-now')).toHaveCount(2);
  await plot.press('2');
  await ready(page);
  await expect(page).toHaveURL(/range=7d/);
  await expect(page.locator('.chart-plot')).toBeFocused();
  expect(await page.locator('.bucket-band').count()).toBeGreaterThan(0);
  const previous = page
    .locator('.usage-trend .chart-tools')
    .first()
    .getByRole('button', { name: locale === 'en' ? 'Previous 7 days' : '前 7 天', exact: true });
  await previous.click();
  await ready(page);
  await expect(page).toHaveURL(/end=/);
  await page
    .getByRole('button', { name: locale === 'en' ? 'Next 7 days' : '后 7 天', exact: true })
    .click();
  await ready(page);
  await expect(previous).toBeFocused();
  await previous.click();
  await ready(page);
  await page.reload();
  await ready(page);
  await expect(page).toHaveURL(/end=/);
  await page
    .getByRole('button', { name: locale === 'en' ? 'Latest' : '最新', exact: true })
    .click();
  await ready(page);
  expect(new URLSearchParams(page.url().split('?').at(-1)).has('end')).toBe(false);
  await expect(previous).toBeFocused();
});
