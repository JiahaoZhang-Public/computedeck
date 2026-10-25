import { test, expect, ready, demoNow } from './fixtures';

const endpoints = ['/api/dashboard', '/api/health', '/api/toolbox', '/api/nodes'];

test('live polling keeps rows and focus, uses since tokens, and respects pointer cadence', async ({
  page,
  hasTouch,
}) => {
  await page.clock.install({ time: new Date(demoNow) });
  await page.goto('/?demo=true#/jobs');
  await ready(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const cadence = hasTouch ? 30000 : 10000;
  const row = page.locator('main [data-detail-key="job"]').first();
  await row.focus();
  const handle = await row.elementHandle();
  const replies: { path: string; since: string | null; body: string }[] = [];
  const pending: Promise<void>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!endpoints.includes(url.pathname)) return;
    pending.push(
      response.text().then((body) => {
        replies.push({ path: url.pathname, since: url.searchParams.get('since'), body });
      }),
    );
  });
  await page.clock.runFor(cadence);
  await expect.poll(() => replies.length).toBe(4);
  await Promise.all(pending);
  expect(replies.map((reply) => reply.path).sort()).toEqual([...endpoints].sort());
  for (const reply of replies) {
    expect(reply.since).toBeTruthy();
    expect(JSON.parse(reply.body)).toMatchObject({ unchanged: true, token: reply.since });
  }
  expect(
    replies.reduce((size, reply) => size + new TextEncoder().encode(reply.body).length, 0),
  ).toBeLessThanOrEqual(1000);
  expect(
    await handle!.evaluate(
      (node) => node === document.querySelector('main [data-detail-key="job"]'),
    ),
  ).toBe(true);
  await expect(row).toBeFocused();
  await expect(page.locator('.toasts[role="status"]')).toHaveText('');
  await expect(
    page.locator('.health-status [role="status"], .service-state[role="status"]'),
  ).toHaveCount(0);
});

test('a job transition announces once in the shared polite region and keeps the row focus', async ({
  page,
  locale,
}) => {
  await page.clock.install({ time: new Date(demoNow) });
  let changed = false;
  let sent = false;
  await page.route('**/api/dashboard?*', async (route) => {
    if (!changed) return route.fallback();
    if (sent) return route.fulfill({ json: { unchanged: true, token: 'transition-token' } });
    const url = new URL(route.request().url());
    url.searchParams.delete('since');
    const response = await route.fetch({ url: url.href });
    const data = await response.json();
    const job = data.jobs[0];
    job.state = job.state === 'RUNNING' ? 'PENDING' : 'RUNNING';
    job.rev = 'transition-rev';
    data.token = 'transition-token';
    sent = true;
    return route.fulfill({ response, json: data });
  });
  await page.goto('/?demo=true#/jobs');
  await ready(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const row = page.locator('main [data-detail-key="job"]').first();
  await row.focus();
  const live = page.locator('.toasts[role="status"]');
  await expect(live).toHaveText('');
  changed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(live).toHaveText(locale === 'zh-CN' ? '1 个作业状态已变化' : '1 job changed state');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveAttribute('aria-atomic', 'false');
  await expect(row).toBeFocused();
  const announcement = await live.locator('.sr-only').elementHandle();
  await page.clock.runFor(30000);
  expect(await announcement!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(row).toBeFocused();
});
