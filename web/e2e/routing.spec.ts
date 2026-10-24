import { test, expect, ready } from './fixtures';

for (const [alias, canonical, view, tab] of [
  ['clusters', 'resources', 'resources', null],
  ['nodes', 'resources?tab=nodes', 'resources', 'nodes'],
  ['marketplace', 'toolbox?tab=market', 'toolbox', 'market'],
] as const) {
  test(`${alias} routing alias preserves Back and reload`, async ({ page, locale }) => {
    await page.goto('/?demo=true#/overview');
    await ready(page);
    await page.evaluate((route) => {
      location.hash = `#/${route}`;
    }, alias);
    await expect(page).toHaveURL(new RegExp(`#/${canonical.replace('?', '\\?')}$`));
    await ready(page);
    await expect(page.locator(`main.page-${view}`)).toBeVisible();
    expect(
      await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('tab')),
    ).toBe(tab);
    if (tab === 'market') {
      await expect(
        page.getByRole('tab', {
          name: locale === 'zh-CN' ? '插件市场' : 'Marketplace',
          exact: true,
        }),
      ).toHaveAttribute('aria-selected', 'true');
    }
    await page.reload();
    await ready(page);
    await expect(page.locator(`main.page-${view}`)).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/overview$/);
    await ready(page);
    await expect(page.locator('main.page-overview')).toBeVisible();
    await page.goForward();
    await ready(page);
    await expect(page.locator(`main.page-${view}`)).toBeVisible();
  });
}

test('legacy node filter keeps its cluster and survives reload', async ({ page, locale }) => {
  await page.goto('/?demo=true#/resources?nodes=abnormal&group=example%3Acluster-a');
  await ready(page);
  expect(
    await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1]))),
  ).toEqual({
    nodes: 'abnormal',
    group: 'example:cluster-a',
    tab: 'nodes',
  });
  await expect(page.locator('.cluster-card')).toHaveCount(1);
  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? /^异常/ : /^Unhealthy/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await ready(page);
  await expect(page.locator('.cluster-card')).toHaveCount(1);
});
