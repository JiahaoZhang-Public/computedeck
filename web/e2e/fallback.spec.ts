import AxeBuilder from '@axe-core/playwright';
import { test, expect, ready } from './fixtures';
import { withScreenshotViewport, settledScreenshot } from './screenshots';

const contexts = [
  { name: 'system-light', system: 'light', theme: null, contrast: 'no-preference' },
  { name: 'system-dark', system: 'dark', theme: null, contrast: 'no-preference' },
  { name: 'explicit-light', system: 'dark', theme: 'light', contrast: 'no-preference' },
  { name: 'explicit-dark', system: 'light', theme: 'dark', contrast: 'no-preference' },
  { name: 'more-light', system: 'dark', theme: 'light', contrast: 'more' },
  { name: 'more-dark', system: 'light', theme: 'dark', contrast: 'more' },
] as const;
for (const route of ['__gallery', 'overview']) {
  const name = route === '__gallery' ? 'gallery' : route;
  for (const context of contexts) {
    test(`fallback ${route} ${context.name}`, async ({ page, freshPage }, testInfo) => {
      for (const target of [page, freshPage]) {
        await target.emulateMedia({ colorScheme: context.system, contrast: context.contrast });
        await target.addInitScript((theme) => {
          localStorage.setItem('computedeck.theme', theme ?? 'system');
        }, context.theme);
      }
      await page.goto(`/__ui-fallback/?demo=true#/${route}`);
      await freshPage.goto(`/?demo=true#/${route}`);
      await ready(page);
      await ready(freshPage);
      await withScreenshotViewport(page, testInfo, (options) =>
        expect(page).toHaveScreenshot(`${name}-${context.name}.png`, options),
      );
      // Rendered component colours and layout also agree, not just custom properties.
      const actual = await settledScreenshot(page, testInfo, 'fallback');
      const normal = await settledScreenshot(freshPage, testInfo, 'normal');
      expect(actual.equals(normal), 'Fallback and normal builds must look identical').toBe(true);
      const fingerprints = async (target: typeof page) => {
        const axe = await new AxeBuilder({ page: target })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        return axe.violations
          .flatMap((item) => item.nodes.map((node) => ({ rule: item.id, target: node.target })))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      };
      const violations = await fingerprints(page);
      expect(violations).toEqual(await fingerprints(freshPage));
      // Overview retains reviewed 0.7 findings until P1/Q1; never omit those rules.
      expect(JSON.stringify(violations, null, 2) + '\n').toMatchSnapshot(
        `${name}-${context.name}.axe.json`,
      );
      await testInfo.attach('axe', {
        body: JSON.stringify(violations),
        contentType: 'application/json',
      });
    });
  }
}
