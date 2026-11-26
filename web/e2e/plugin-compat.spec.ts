import AxeBuilder from '@axe-core/playwright';
import { wcagTags, test, expect, ready } from './fixtures';
import { withScreenshotViewport, settledScreenshot } from './screenshots';

// Same six projects as core: both locales, both themes and all three widths.
test('scaffold hello plugin page, public components/classes and all slots', async ({
  page,
  locale,
}, testInfo) => {
  const chinese = locale === 'zh-CN';
  await page.goto('/__ui-plugins/?demo=true#/hello-example');
  await ready(page);
  await expect(page.locator('main .panel-header h2')).toHaveText('Hello example');
  const api = await page.evaluate(() => ({
    version: window.ComputeDeck?.api,
    components: Object.keys(window.ComputeDeck?.components ?? {}),
  }));
  expect(api).toEqual({
    version: 1,
    components: ['BrandMark', 'Chips', 'Empty', 'Meter', 'Panel', 'Stat', 'Status', 'Switch'],
  });
  for (const selector of [
    '.panel',
    '.panel-header',
    '.panel-note',
    '.button',
    '.primary-button',
    '.secondary-button',
    '.primary',
    '.form-error',
    '.num',
    '.spin',
    '.status.green',
    '.status.amber',
    '.status.red',
    '.table-wrap',
    '.table',
    '.compact',
    '.sub',
    '.muted',
    '.red-text',
    '.red',
    '.amber',
    '.link',
    'input',
    'select',
    'a',
    '[role=tab]',
  ])
    await expect(page.locator(`main ${selector}`).first()).toBeVisible();
  await expect(page.locator('main .table')).toHaveCSS('border-collapse', 'collapse');
  await expect(page.locator('main .table td.num')).toHaveCSS(
    'font-variant-numeric',
    'tabular-nums',
  );
  const banner = page
    .locator('.plugin-slot[data-plugin="hello-example"]')
    .filter({ has: page.locator('.banner') });
  await expect(banner).toHaveCount(0);
  const switchName = chinese ? '显示横幅' : 'Show banner';
  const toggle = page.getByRole('switch', { name: switchName });
  const toggleLabel = page.locator('label.switch', { hasText: switchName });
  await expect(toggle).not.toBeChecked();
  await toggleLabel.click();
  await expect(toggle).toBeChecked();
  await expect(banner).toBeVisible();
  expect(await banner.locator(':scope > *').count()).toBe(1);
  await expect(banner.locator('h2')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(wcagTags).analyze()).violations).toEqual([]);
  await settledScreenshot(page, testInfo, 'hello-page');
  await withScreenshotViewport(page, testInfo, async (options) => {
    if (testInfo.project.use.hasTouch)
      expect(
        await page.evaluate(() => window.scrollY),
        'Hello capture starts above the example banner',
      ).toBe(0);
    await expect(page).toHaveScreenshot('hello-page.png', options);
  });
  await toggleLabel.click();
  await expect(toggle).not.toBeChecked();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#/overview';
  });
  await ready(page);
  const overview = page.locator('main .plugin-slot[data-plugin="hello-example"]');
  await expect(overview.locator(':scope > .panel')).toHaveCount(1);
  await expect(overview.locator('h2')).toHaveText(chinese ? '示例概览' : 'Example overview');
  const empty = page.locator('main .plugin-slot[data-plugin="fixture-null"]');
  await expect(empty).toBeHidden();
  expect(await empty.evaluate((node) => node.getBoundingClientRect().height)).toBe(0);
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await ready(page);
  await expect(page.locator('main .plugin-slot[data-plugin="hello-example"] h2')).toHaveText(
    chinese ? '示例设置' : 'Example settings',
  );
  await page.evaluate(() => {
    location.hash = '#/fixture-page-only';
  });
  await ready(page);
  await expect(page.locator('main h2')).toHaveText(chinese ? '独立页面' : 'Page only');
  await expect(page.locator('[data-plugin="fixture-page-only"]')).toHaveCount(0);
});

test('scaffold spinner stays icon-sized with motion enabled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/__ui-plugins/?demo=true#/hello-example');
  await ready(page);
  const spinner = page.locator('main svg.spin');
  await expect(spinner).toHaveCount(1);
  const boxes = await spinner.evaluate(async (node) => {
    const boxes: { width: number; height: number }[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(requestAnimationFrame);
      const rect = node.getBoundingClientRect();
      boxes.push({ width: rect.width, height: rect.height });
    }
    return boxes;
  });
  for (const box of boxes) {
    expect(box.width).toBeLessThanOrEqual(23);
    expect(box.height).toBeLessThanOrEqual(23);
  }
});
