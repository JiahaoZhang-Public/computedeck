import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, ready } from './fixtures';
import { checkLayout } from './checks';
import { tokens } from '../src/theme/tokens';
import aliases from '../src/theme/compat-map.json' with { type: 'json' };

const colors = [
  ...Object.keys(tokens).map((name) => `--${name}`),
  ...Object.keys(aliases).filter((name) => !['--mono', '--radius', '--radius-sm'].includes(name)),
];
async function computedColors(page: Page) {
  return page.evaluate((names) => {
    const probe = document.createElement('span');
    probe.style.forcedColorAdjust = 'none';
    document.body.append(probe);
    const result = Object.fromEntries(
      names.map((name) => {
        probe.style.backgroundColor = `var(${name})`;
        return [name, getComputedStyle(probe).backgroundColor];
      }),
    );
    probe.remove();
    return result;
  }, colors);
}

for (const more of [false, true]) {
  test(`gallery compat has no axe violations, contrast-more=${more}`, async ({ page }) => {
    await page.emulateMedia({ contrast: more ? 'more' : 'no-preference' });
    await page.goto('/?demo=true#/__gallery?compat');
    await ready(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    for (const selector of ['.button.primary', '.button.primary-button']) {
      const button = page.locator(`.gallery ${selector}`).first();
      await button.hover();
      expect((await new AxeBuilder({ page }).include('.gallery').analyze()).violations).toEqual([]);
    }
  });
  test(`normal/fallback token parity in every theme context, contrast-more=${more}`, async ({
    page,
    freshPage,
  }) => {
    await page.emulateMedia({ contrast: more ? 'more' : 'no-preference' });
    await freshPage.emulateMedia({ contrast: more ? 'more' : 'no-preference' });
    await page.goto('/?demo=true#/__gallery?compat');
    await freshPage.goto('/__ui-fallback/?demo=true#/__gallery?compat');
    await ready(page);
    await ready(freshPage);
    for (const system of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: system });
      await freshPage.emulateMedia({ colorScheme: system });
      for (const theme of ['system', 'light', 'dark']) {
        for (const target of [page, freshPage])
          await target.evaluate((value) => {
            if (value === 'system') delete document.documentElement.dataset.theme;
            else document.documentElement.dataset.theme = value;
          }, theme);
        expect(await computedColors(freshPage), `${system}/${theme}`).toEqual(
          await computedColors(page),
        );
        expect(
          await freshPage.locator('html').evaluate((node) => getComputedStyle(node).colorScheme),
        ).toEqual(
          await page.locator('html').evaluate((node) => getComputedStyle(node).colorScheme),
        );
      }
    }
  });
}

test('theme and table density persist, system follows the OS, forms keep their height', async ({
  page,
}) => {
  await page.goto('/?demo=true#/settings');
  await ready(page);
  for (const value of ['dark', 'light']) {
    await page.locator('#theme').selectOption(value);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await page.reload();
    await ready(page);
    await expect(page.locator('#theme')).toHaveValue(value);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  }
  const formHeight = await page
    .locator('#theme')
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.locator('#density').selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await page.locator('#theme').evaluate((node) => node.getBoundingClientRect().height)).toBe(
    formHeight,
  );
  await page.locator('#theme').selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await computedColors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await computedColors(page)).not.toEqual(light);
  await page.reload();
  await ready(page);
  await expect(page.locator('#density')).toHaveValue('compact');
  await expect(page.locator('#theme')).toHaveValue('system');
});

test('table row boxes include hairlines: density, compact class and coarse pointers', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery?compat');
  await ready(page);
  const table = page.locator('.gallery .table');
  // Reuse the translated gallery sample, checking both bordered and last rows.
  await table.evaluate((node) => {
    const body = node.querySelector('tbody')!;
    const example = body.querySelector('tr')!;
    body.replaceChildren(
      ...[1, 2, 1, 2].map((lines) => {
        const row = example.cloneNode(true) as HTMLTableRowElement;
        if (lines === 1) row.querySelectorAll('.sub').forEach((sub) => sub.remove());
        return row;
      }),
    );
  });
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  for (const density of ['comfortable', 'compact']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.density = value;
    }, density);
    for (const compactClass of [false, true]) {
      await table.evaluate(
        (node, enabled) => node.classList.toggle('compact', enabled),
        compactClass,
      );
      const dense = density === 'compact' || compactClass;
      const single = coarse ? 44 : dense ? 32 : 40;
      const two = coarse ? 60 : dense ? 48 : 60;
      const heights = await table
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(heights, `${density}, .compact=${compactClass}, coarse=${coarse}`).toEqual([
        single,
        two,
        single,
        two,
      ]);
      // Include the borderless single-line last row, too.
      await table.evaluate((node) => node.querySelector('tbody')!.lastElementChild!.remove());
      expect(
        await table
          .locator('tbody tr')
          .last()
          .evaluate((row) => row.getBoundingClientRect().height),
      ).toBe(single);
      await table.evaluate((node) => {
        const body = node.querySelector('tbody')!;
        body.append(body.children[1].cloneNode(true));
      });
    }
  }
  // A future grid/block layout must grow, without needing a page-specific height reset.
  await table.evaluate((node) => {
    for (const row of node.querySelectorAll<HTMLElement>('tr')) row.style.display = 'grid';
    for (const cell of node.querySelectorAll<HTMLElement>('td,th')) {
      cell.style.display = 'block';
      const content = document.createElement('div');
      content.style.height = '100px';
      cell.append(content);
    }
  });
  expect((await checkLayout(page)).filter(({ kind }) => kind === 'cell-overflow')).toEqual([]);
});

test('cell-overflow guard detects clipped non-table cells and clears after they grow', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery?compat');
  await ready(page);
  for (const display of ['block', 'grid', 'flex']) {
    await page.evaluate((mode) => {
      document.querySelector('#cell-probe')?.remove();
      const table = document.createElement('table');
      table.id = 'cell-probe';
      const row = table.insertRow();
      for (const tag of ['td', 'th']) {
        const cell = document.createElement(tag);
        cell.style.cssText = `display: ${mode}; height: 1px; overflow: hidden;`;
        const content = document.createElement('div');
        content.style.height = '80px';
        content.textContent = `${tag} overflow probe`;
        cell.append(content);
        row.append(cell);
      }
      document.querySelector('main')!.append(table);
    }, display);
    const findings = (await checkLayout(page)).filter(({ kind }) => kind === 'cell-overflow');
    expect(findings.map(({ identity }) => identity)).toEqual([
      'td: td overflow probe',
      'th: th overflow probe',
    ]);
    for (const finding of findings)
      expect(finding.scrollHeight!).toBeGreaterThan(finding.height! + 1);
    await page.locator('#cell-probe td,#cell-probe th').evaluateAll((cells) => {
      for (const cell of cells) (cell as HTMLElement).style.height = 'auto';
    });
    expect((await checkLayout(page)).filter(({ kind }) => kind === 'cell-overflow')).toEqual([]);
  }
});

test('ships the complete compatibility map with the web app', async ({ page }) => {
  const response = await page.request.get('/tokens-compat.json');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual(aliases);
});

test('forced colours override explicit themes in both builds', async ({ page, freshPage }) => {
  for (const target of [page, freshPage]) await target.emulateMedia({ forcedColors: 'active' });
  await page.goto('/?demo=true#/__gallery?compat');
  await freshPage.goto('/__ui-fallback/?demo=true#/__gallery?compat');
  await ready(page);
  await ready(freshPage);
  for (const theme of ['light', 'dark']) {
    for (const target of [page, freshPage])
      await target.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
    expect(await computedColors(freshPage)).toEqual(await computedColors(page));
  }
});
