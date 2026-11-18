import { test as base, expect, type Page } from '@playwright/test';

export const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const configuredDemoNow = process.env.COMPUTEDECK_DEMO_NOW;
if (!configuredDemoNow)
  throw new Error('COMPUTEDECK_DEMO_NOW is required; run bash scripts/check-ui.sh');
export const demoNow = configuredDemoNow;

async function setupPage(page: Page, baseURL: string | undefined, locale: string | undefined) {
  if (!baseURL) throw new Error('Run bash scripts/check-ui.sh to start the isolated service');
  const origin = new URL(baseURL).origin;
  const blocked: string[] = [];
  const errors: string[] = [];
  const serverErrors: string[] = [];
  const responses: Promise<void>[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).origin !== origin || response.status() < 500) return;
    responses.push(
      response.serverAddr().then((address) => {
        // route.fulfill fixtures have no service connection.
        if (address) serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }),
    );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    // Environment metadata is not example data. Keep machine names, paths and service
    // startup time out of public screenshots; all metrics still come from the real API.
    if (url.pathname === '/api/health') {
      const response = await route.fetch();
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} /api/health`);
        return route.fulfill({ response });
      }
      const health = await response.json();
      if (health.unchanged === true) return route.fulfill({ response });
      return route.fulfill({
        response,
        json: {
          ...health,
          server_host: 'example.test',
          database_path: '/tmp/computedeck-example/computedeck.sqlite',
          started_at: demoNow,
        },
      });
    }
    return route.continue();
  });
  await page.clock.setFixedTime(new Date(demoNow));
  await page.addInitScript((language) => {
    localStorage.setItem('computedeck.locale', language);
  }, locale ?? 'en');
  return async () => {
    await Promise.all(responses);
    expect(serverErrors, 'Service 5xx responses').toEqual([]);
    expect(blocked, 'Unexpected non-local requests (aborted)').toEqual([]);
    expect(errors, 'Browser runtime errors').toEqual([]);
  };
}

export const test = base.extend<{ freshPage: Page }>({
  page: async ({ page, baseURL, locale }, run) => {
    const check = await setupPage(page, baseURL, locale);
    try {
      await run(page);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await check();
    }
  },
  freshPage: async (
    {
      browser,
      contextOptions,
      baseURL,
      viewport,
      locale,
      colorScheme,
      hasTouch,
      timezoneId,
      reducedMotion,
      serviceWorkers,
    },
    run,
  ) => {
    // Same resolved project options; no cookies, storage or scroll history from the first page.
    const context = await browser.newContext({
      ...contextOptions,
      baseURL,
      viewport,
      locale,
      colorScheme,
      hasTouch,
      timezoneId,
      reducedMotion,
      serviceWorkers,
    });
    try {
      const page = await context.newPage();
      const check = await setupPage(page, baseURL, locale);
      try {
        await run(page);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await check();
      }
    } finally {
      await context.close();
    }
  },
});
export { expect };

// Only explicitly marked static samples inside the gallery are exempt from readiness.
export const busyRegions =
  '[aria-busy="true"]:not(main.page-__gallery .gallery [data-static-sample] *)';
export async function ready(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  // Page-specific reads (history, events, tool settings) start after the dashboard.
  await page.waitForLoadState('networkidle');
  await expect(
    page.locator('[data-static-sample]:not(main.page-__gallery .gallery *)'),
  ).toHaveCount(0);
  await expect(page.locator(busyRegions)).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('main')).not.toBeEmpty();
}

export async function fontGuard(page: Page, locale = 'en') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  if (!locale.startsWith('zh')) return;
  const session = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.id = 'cjk-font-probe';
      probe.textContent = '集群排队数据';
      probe.style.fontFamily = getComputedStyle(document.querySelector('main')!).fontFamily;
      document.body.append(probe);
    });
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#cjk-font-probe',
    });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    const used = fonts.filter((font) => font.glyphCount > 0).map((font) => font.familyName);
    const expected =
      process.platform === 'linux'
        ? /Noto Sans CJK SC/
        : /PingFang SC|Hiragino Sans GB|Microsoft YaHei|Noto Sans CJK SC/;
    expect(used.length, 'No CJK glyphs rendered').toBeGreaterThan(0);
    expect(
      used.every((font) => expected.test(font)),
      `Unexpected Han fonts: ${used.join(', ')}`,
    ).toBe(true);
  } finally {
    await page.locator('#cjk-font-probe').evaluate((node) => node.remove());
    await session.detach();
  }
}
