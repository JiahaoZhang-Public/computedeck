// Capture screenshots of the built-in example data from a running service.
//
//   node scripts/screenshots.mjs [base-url] [output-dir] [--review]
//
// Without --review it writes the five images the README shows. With --review it writes
// every page in both themes and at phone width, for looking over a design change.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const review = process.argv.includes('--review');
const base = args[0] ?? 'http://127.0.0.1:8710';
const out = path.resolve(args[1] ?? '../docs/assets/screens');
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const plan = '#/plan?gpus=4&model=H100&hours=24';

/** Open the first queued job whose reason is a per-user limit: the README's example. */
async function openQueuedJob(page) {
  const row = page.locator('[data-detail-key="job"]', { hasText: 'llm-sft / ablation' }).first();
  await row.click();
  await page.locator('[role="dialog"], .drawer').first().waitFor();
}

const readme = [
  { name: 'overview', hash: '#/overview', viewport: desktop },
  { name: 'routes', hash: '#/sources', viewport: { width: 1440, height: 620 } },
  { name: 'where-to-run', hash: plan, viewport: desktop },
  { name: 'job-detail', hash: '#/jobs', viewport: desktop, prepare: openQueuedJob },
  { name: 'phone-overview', hash: '#/overview', viewport: phone, scale: 3 },
];
const pages = [
  'overview',
  'plan',
  'jobs',
  'activity',
  'resources',
  'cloud',
  'usage',
  'sources',
  'toolbox',
  'settings',
];
const all = [
  ...pages.flatMap((name) => [
    { name: `${name}-light`, hash: `#/${name}`, viewport: desktop, full: true },
    { name: `${name}-dark`, hash: `#/${name}`, viewport: desktop, dark: true, full: true },
    { name: `${name}-phone`, hash: `#/${name}`, viewport: phone, full: true },
  ]),
  { name: 'job-detail-light', hash: '#/jobs', viewport: desktop, prepare: openQueuedJob },
  {
    name: 'job-detail-dark',
    hash: '#/jobs',
    viewport: desktop,
    dark: true,
    prepare: openQueuedJob,
  },
  { name: 'job-detail-phone', hash: '#/jobs', viewport: phone, prepare: openQueuedJob },
  { name: 'plan-request-light', hash: plan, viewport: desktop, full: true },
  { name: 'first-run-light', hash: '#/overview', viewport: desktop, live: true },
  { name: 'add-source-light', hash: '#/sources?add=source', viewport: desktop, live: true },
  { name: 'add-route-light', hash: '#/sources?route=new', viewport: desktop, live: true },
];

mkdirSync(out, { recursive: true });
// Like the UI gate: the bundled Chromium when it is installed, else Google Chrome.
const channel = process.env.PLAYWRIGHT_CHANNEL;
const browser = await chromium
  .launch(channel ? { channel } : {})
  .catch(() => chromium.launch({ channel: 'chrome' }));
for (const shot of review ? all : readme) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: shot.scale ?? 2,
    colorScheme: shot.dark ? 'dark' : 'light',
    locale: 'en-US',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(`${base}/${shot.live ? '' : '?demo=true'}${shot.hash}`);
  await page.locator('main').waitFor();
  await page.waitForLoadState('networkidle');
  if (shot.prepare) await shot.prepare(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${shot.name}.png`), fullPage: !!shot.full });
  await context.close();
  console.log(shot.name);
}
await browser.close();
