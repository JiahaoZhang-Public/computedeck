import AxeBuilder from '@axe-core/playwright';
import { test, expect, ready, fontGuard } from './fixtures';
import { checkLayout, checkFocus } from './checks';
import { domFingerprints } from './dom-findings';
import { screenshotOptions, settledScreenshot } from './screenshots';

// Twelve 0.7 routes plus the existing Nodes and Marketplace page states. No new aliases.
const pages = [
  ['overview', 'overview'],
  ['jobs', 'jobs'],
  ['activity', 'activity'],
  ['clusters', 'resources'],
  ['nodes', 'resources?nodes=abnormal'],
  ['cloud', 'cloud'],
  ['usage', 'usage'],
  ['plan', 'plan'],
  ['sources', 'sources'],
  ['toolbox', 'toolbox'],
  ['marketplace', 'toolbox?tab=market'],
  ['notify', 'notify'],
  ['chat', 'chat'],
  ['settings', 'settings'],
  ['gallery', '__gallery'],
  ['gallery-compat', '__gallery?compat'],
];

for (const [name, route] of pages) {
  test(`${name} UI gate`, async ({ page, freshPage, locale }, testInfo) => {
    await page.goto(`/?demo=true#/${route}`);
    await ready(page);
    await fontGuard(page, locale);
    if (name === 'activity') {
      await expect(page.locator('.activity-day').first()).toBeVisible();
      await expect(page.locator('.activity > li').first()).toBeVisible();
    }
    const first = await settledScreenshot(page, testInfo, 'first-run');
    await expect.soft(page).toHaveScreenshot(`${name}.png`, screenshotOptions(page));
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('axe', {
      body: JSON.stringify(axe.violations, null, 2),
      contentType: 'application/json',
    });
    // Existing violations are reviewable baseline entries, never a blanket rule exclusion.
    // Removing an entry is welcome; adding one needs explicit baseline review at PR time.
    const fingerprints = axe.violations
      .flatMap((violation) =>
        violation.nodes.map((node) => ({
          rule: violation.id,
          target: node.target,
        })),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect.soft(JSON.stringify(fingerprints, null, 2) + '\n').toMatchSnapshot(`${name}.axe.json`);
    const findings = await checkLayout(page);
    await testInfo.attach('dom', {
      body: JSON.stringify(findings, null, 2),
      contentType: 'application/json',
    });
    expect
      .soft(JSON.stringify(domFingerprints(findings), null, 2) + '\n')
      .toMatchSnapshot(`${name}.dom.json`);
    await checkFocus(page);
    // A second run starts with empty storage and scroll history, not an Activity revisit.
    await freshPage.goto(`/?demo=true#/${route}`);
    await ready(freshPage);
    await fontGuard(freshPage, locale);
    const second = await settledScreenshot(freshPage, testInfo, 'second-run');
    if (!second.equals(first)) {
      await testInfo.attach('first-run', { body: first, contentType: 'image/png' });
      await testInfo.attach('second-run', { body: second, contentType: 'image/png' });
    }
    expect(second.equals(first), 'Two fresh contexts must render identical screenshots').toBe(true);
  });
}

test('jobs reason at 1280 zh with panel open @known-clip', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-1280-zh-CN-dark', '1280 zh regression case');
  await page.goto('/?demo=true#/jobs?state=pending&job=example%3Acluster-a%3A48214');
  await ready(page);
  await expect(page.getByRole('dialog')).toBeVisible();
  const reasons = page.locator('.jobs-table tbody .clamp[title]');
  await expect(reasons.first()).toBeVisible();
  const clipped = await reasons.evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const box = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        const center = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return (
          node.scrollWidth > node.clientWidth ||
          node.scrollHeight > node.clientHeight ||
          text.right > box.right + 1 ||
          text.bottom > box.bottom + 1 ||
          !center ||
          !(node.contains(center) || center.contains(node))
        );
      })
      .map((node) => node.textContent),
  );
  // TODO P2: require no clipped reasons once the Jobs layout is fixed.
  // Record the known defect without marking unrelated test or teardown errors as expected.
  expect(clipped.length, 'Known 0.7 Jobs clipping; update this assertion in P2').toBeGreaterThan(0);
});
