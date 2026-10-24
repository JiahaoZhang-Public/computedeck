import { test, expect, ready } from './fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const script = (name: string) => new RegExp(`/assets/${name}-[^/]+\\.js$`);

test('Overview loads only its active locale and defers routes, forms and gallery CSS', async ({
  page,
  locale,
}) => {
  const assets: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/assets/')) assets.push(request.url());
  });
  await page.goto('/?demo=true#/overview');
  await ready(page);
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const other = language === 'en' ? 'zh-CN' : 'en';
  expect(assets.some((url) => script(language).test(url))).toBe(true);
  expect(assets.some((url) => script(other).test(url))).toBe(false);
  for (const name of [
    'Plan',
    'Usage',
    'Toolbox',
    'Notify',
    'Chat',
    'Settings',
    'forms',
    'Gallery',
  ]) {
    expect(
      assets.some((url) => script(name).test(url)),
      `${name} must stay lazy`,
    ).toBe(false);
  }
  expect(assets.some((url) => /\/Gallery-[^/]+\.css$/.test(url))).toBe(false);
  expect(
    await page.evaluate(() => ({
      api: window.ComputeDeck?.api,
      aliases: window.ComputeDeck?.routeAliases,
      components: Object.keys(window.ComputeDeck?.components ?? {}).sort(),
    })),
  ).toEqual({
    api: 1,
    aliases: {
      clusters: 'resources',
      nodes: 'resources?tab=nodes',
      marketplace: 'toolbox?tab=market',
    },
    components: ['BrandMark', 'Chips', 'Empty', 'Meter', 'Panel', 'Stat', 'Status', 'Switch'],
  });
  await page.evaluate(() => {
    location.hash = '#/__gallery?compat';
  });
  await ready(page);
  await expect(page.locator('[data-token]')).toHaveCount(21);
  expect(assets.some((url) => script('Gallery').test(url))).toBe(true);
  expect(assets.some((url) => /\/Gallery-[^/]+\.css$/.test(url))).toBe(true);
});

test('startup keeps the loaded language if storage changes during the request', async ({
  page,
  locale,
}) => {
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const arrived = deferred();
  const release = deferred();
  await page.route(script(language), async (route) => {
    arrived.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.goto('/?demo=true#/overview', { waitUntil: 'domcontentloaded' });
    await arrived.promise;
    const status = page.getByRole('status');
    await expect(status).toHaveText(language === 'en' ? 'Loading…' : '正在载入…');
    expect((await status.boundingBox())!.x).toBeGreaterThanOrEqual(16);
    await page.evaluate(
      (next) => localStorage.setItem('computedeck.locale', next),
      language === 'en' ? 'zh-CN' : 'en',
    );
    release.resolve();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('.topbar h1')).toHaveText(language === 'en' ? 'Overview' : '总览');
  } finally {
    release.resolve();
  }
});

test('a failed startup dictionary keeps its error and retry inside the viewport gutter', async ({
  page,
  locale,
}) => {
  await page.route(script(locale === 'zh-CN' ? 'zh-CN' : 'en'), (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page.goto('/?demo=true#/overview');
  const error = page.getByRole('alert');
  await expect(error).toHaveText(
    locale === 'zh-CN' ? '无法加载语言，请重试。' : 'Could not load the language. Try again.',
  );
  const retry = page.getByRole('button', {
    name: locale === 'zh-CN' ? '重试' : 'Retry',
    exact: true,
  });
  for (const element of [error, retry]) {
    await expect(element).toBeVisible();
    const box = (await element.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  }
});

test('a delayed lazy route keeps the frame usable and cannot replace a newer route', async ({
  page,
}) => {
  const arrived = deferred();
  const release = deferred();
  await page.route(script('Plan'), async (route) => {
    arrived.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.goto('/?demo=true#/overview');
    await ready(page);
    await page.evaluate(() => {
      location.hash = '#/plan?gpus=4';
    });
    await arrived.promise;
    await expect(page.locator('main.page-plan [aria-busy="true"]')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    await page.goBack();
    await expect(page.locator('main.page-overview .loading')).toHaveCount(0);
    release.resolve();
    await ready(page);
    await expect(page.locator('main.page-overview')).toBeVisible();
    await page.goForward();
    await ready(page);
    await expect(page.locator('main.page-plan input[type="number"]').first()).toHaveValue('4');
  } finally {
    release.resolve();
  }
});

test('a failed lazy route offers reload and leaves navigation working', async ({
  page,
  locale,
}) => {
  await page.route(script('Plan'), (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/?demo=true#/plan?gpus=4');
  await ready(page);
  await expect(page.locator('main [role="alert"]')).toContainText(
    locale === 'zh-CN' ? '无法加载此视图' : 'Could not load this view',
  );
  await page.evaluate(() => {
    location.hash = '#/jobs?state=pending';
  });
  await ready(page);
  await expect(page.locator('main.page-jobs .jobs-table')).toBeVisible();
  await page.goBack();
  await ready(page);
  await page.unroute(script('Plan'));
  await page
    .locator('main')
    .getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true })
    .click();
  await ready(page);
  await expect(page.locator('main.page-plan input[type="number"]').first()).toHaveValue('4');
});

test('language switching waits for the inactive dictionary and keeps the current URL', async ({
  page,
  locale,
}) => {
  const initial = locale === 'zh-CN' ? 'zh-CN' : 'en';
  const next = initial === 'en' ? 'zh-CN' : 'en';
  const arrived = deferred();
  const release = deferred();
  await page.route(script(next), async (route) => {
    arrived.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.goto('/?demo=true#/settings?group=example%3Acluster-a');
    await ready(page);
    const language = page.getByRole('combobox', {
      name: initial === 'en' ? 'Language' : '语言',
      exact: true,
    });
    await language.selectOption(next);
    await arrived.promise;
    await expect(page.locator('html')).toHaveAttribute('lang', initial);
    await expect(language).toHaveValue(next);
    await expect(language).toHaveAttribute('aria-busy', 'true');
    release.resolve();
    await expect(page.locator('html')).toHaveAttribute('lang', next);
    await expect(page.locator('.topbar h1')).toHaveText(next === 'en' ? 'Settings' : '设置');
    await expect(
      page.getByRole('combobox', { name: next === 'en' ? 'Language' : '语言', exact: true }),
    ).toHaveAttribute('aria-busy', 'false');
    await expect(page).toHaveURL(/#\/settings\?group=example%3Acluster-a$/);
    expect(await page.evaluate(() => localStorage.getItem('computedeck.locale'))).toBe(next);
    await page
      .getByRole('combobox', { name: next === 'en' ? 'Language' : '语言', exact: true })
      .selectOption(initial);
    await expect(page.locator('html')).toHaveAttribute('lang', initial);
  } finally {
    release.resolve();
  }
});

test('a failed form uses only its title as the dialog name', async ({ page, locale }) => {
  await page.route(script('forms'), (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/#/sources');
  await ready(page);
  const add = page.locator('.topbar').getByRole('button', {
    name: locale === 'zh-CN' ? '添加来源' : 'Add source',
    exact: true,
  });
  await add.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName(
    locale === 'zh-CN' ? '这个表单无法显示' : 'This form could not be shown',
  );
  await expect(dialog.getByRole('alert')).toContainText(
    locale === 'zh-CN' ? '无法加载此视图' : 'Could not load this view',
  );
  await expect(
    dialog.getByRole('button', { name: locale === 'zh-CN' ? '重试' : 'Retry', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('a cold form keeps its focus shell and can close before the chunk arrives', async ({
  page,
  locale,
}) => {
  const arrived = deferred();
  const release = deferred();
  await page.route(script('forms'), async (route) => {
    arrived.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page.goto('/#/sources');
    await ready(page);
    const add = page
      .locator('.topbar')
      .getByRole('button', { name: locale === 'zh-CN' ? '添加来源' : 'Add source', exact: true });
    await add.click();
    await arrived.promise;
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    await expect(dialog).toHaveAccessibleName(locale === 'zh-CN' ? '正在载入…' : 'Loading…');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    release.resolve();
    await page.waitForLoadState('networkidle');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await add.click();
    await expect(
      dialog.getByRole('heading', {
        name: locale === 'zh-CN' ? '添加来源' : 'Add source',
        exact: true,
      }),
    ).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
  } finally {
    release.resolve();
  }
});

for (const form of ['source', 'instance'] as const) {
  test(`a cold ${form} form stays open and focuses its field with Tab contained`, async ({
    page,
    locale,
  }) => {
    const arrived = deferred();
    const release = deferred();
    await page.route(script('forms'), async (route) => {
      arrived.resolve();
      await release.promise;
      await route.continue();
    });
    try {
      await page.goto(form === 'source' ? '/#/sources' : '/#/cloud');
      await ready(page);
      const name =
        form === 'source'
          ? locale === 'zh-CN'
            ? '添加来源'
            : 'Add source'
          : locale === 'zh-CN'
            ? '添加实例'
            : 'Add instance';
      const add = page.locator('.topbar').getByRole('button', { name, exact: true });
      await add.click();
      await arrived.promise;
      const dialog = page.getByRole('dialog');
      const close = dialog.getByRole('button', {
        name: locale === 'zh-CN' ? '关闭' : 'Close',
        exact: true,
      });
      await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
      await expect(close).toBeFocused();
      release.resolve();
      if (form === 'source') {
        // Add source first asks for a type; the details step owns the autoFocus field.
        await dialog.getByRole('button', { name: /Slurm/ }).click();
      }
      const field = dialog.getByLabel(
        form === 'source'
          ? locale === 'zh-CN'
            ? '集群名称'
            : 'Cluster name'
          : locale === 'zh-CN'
            ? '名称'
            : 'Name',
        { exact: true },
      );
      await expect(field).toBeFocused();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
      // Exercise both wrap boundaries after the lazy content has replaced the placeholder.
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.locator('button[type="submit"], button.primary').last()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(add).toBeFocused();
    } finally {
      release.resolve();
    }
  });
}
