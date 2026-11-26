import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { wcagTags, test, expect, ready } from './fixtures';
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

test('saved appearance applies with the application bundle unavailable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('computedeck.theme', 'dark');
    localStorage.setItem('computedeck.density', 'compact');
  });
  await page.route('**/*.js', (route) => route.abort());
  await page.goto('/?demo=true#/settings');
  await expect(page.locator('#root')).toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('meta[name="theme-color"][data-theme="dark"]')).toHaveAttribute(
    'media',
    'all',
  );
});

test('Plan wait pills keep one clock and uncoloured plugin pills have no invented status', async ({
  page,
}) => {
  await page.goto('/?demo=true#/plan');
  await ready(page);
  const waiting = page.locator('.plan-verdict .status.wait');
  expect(await waiting.count()).toBeGreaterThan(0);
  for (const pill of await waiting.all()) {
    await expect(pill.locator('svg')).toHaveCount(1);
    expect(await pill.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('none');
  }
  const shapes = await page.evaluate(() => {
    const samples = ['', 'wait', 'green', 'amber', 'red'].map((tone) => {
      const pill = document.createElement('span');
      pill.className = `status ${tone}`;
      pill.textContent = 'Idle';
      document.querySelector('main')!.append(pill);
      const content = getComputedStyle(pill, '::before').content;
      // Coloured pills that supply an SVG must also keep just their own icon.
      pill.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      const withIcon = getComputedStyle(pill, '::before').content;
      pill.remove();
      return { tone, content, withIcon };
    });
    return samples;
  });
  for (const { tone, content, withIcon } of shapes) {
    expect(content).toBe(['green', 'amber', 'red'].includes(tone) ? '""' : 'none');
    expect(withIcon).toBe('none');
  }
});

const typographyKinds = new Set(['small-text', 'unsupported-font-weight']);
for (const route of ['plan', 'activity', 'usage']) {
  test(`${route} visible text uses at least 12px and weights 400/500/600`, async ({ page }) => {
    await page.goto(`/?demo=true#/${route}`);
    await ready(page);
    expect((await checkLayout(page)).filter(({ kind }) => typographyKinds.has(kind))).toEqual([]);
  });
}

test('typography guard detects small and bold text but ignores hidden text', async ({ page }) => {
  await page.goto('/?demo=true#/settings');
  await ready(page);
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'type-probe';
    probe.innerHTML =
      '<span style="font-size: 11px">Small probe</span>' +
      '<span style="font-weight: 700">Bold probe</span>' +
      '<span hidden style="font-size: 10px; font-weight: 700">Hidden probe</span>';
    document.querySelector('main')!.append(probe);
  });
  expect((await checkLayout(page)).filter(({ kind }) => typographyKinds.has(kind))).toEqual([
    { kind: 'small-text', identity: 'span: Small probe', fontSize: 11 },
    { kind: 'unsupported-font-weight', identity: 'span: Bold probe', fontWeight: '700' },
  ]);
  await page.locator('#type-probe').evaluate((node) => node.remove());
  expect((await checkLayout(page)).filter(({ kind }) => typographyKinds.has(kind))).toEqual([]);
});

for (const more of [false, true]) {
  test(`gallery compat has no axe violations, contrast-more=${more}`, async ({ page }) => {
    await page.emulateMedia({ contrast: more ? 'more' : 'no-preference' });
    await page.goto('/?demo=true#/__gallery?compat');
    await ready(page);
    const result = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
    expect(result.violations).toEqual([]);
    for (const selector of ['.button.primary', '.button.primary-button']) {
      const button = page.locator(`.gallery ${selector}`).first();
      await button.hover();
      expect(
        (await new AxeBuilder({ page }).withTags(wcagTags).include('.gallery').analyze())
          .violations,
      ).toEqual([]);
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
    await page.getByRole('combobox', { name: /^(Theme|主题)$/ }).selectOption(value);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await page.reload();
    await ready(page);
    await expect(page.getByRole('combobox', { name: /^(Theme|主题)$/ })).toHaveValue(value);
    await expect(page.locator(`meta[name="theme-color"][data-theme="${value}"]`)).toHaveAttribute(
      'media',
      'all',
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  }
  const formHeight = await page
    .getByRole('combobox', { name: /^(Theme|主题)$/ })
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.getByRole('combobox', { name: /^(Table density|表格密度)$/ }).selectOption('compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(
    await page
      .getByRole('combobox', { name: /^(Theme|主题)$/ })
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(formHeight);
  await page.getByRole('combobox', { name: /^(Theme|主题)$/ }).selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await computedColors(page);
  await expect(page.locator('meta[name="theme-color"][data-theme="light"]')).toHaveAttribute(
    'media',
    '(prefers-color-scheme: light)',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await computedColors(page)).not.toEqual(light);
  await page.reload();
  await ready(page);
  await expect(page.getByRole('combobox', { name: /^(Table density|表格密度)$/ })).toHaveValue(
    'compact',
  );
  await expect(page.getByRole('combobox', { name: /^(Theme|主题)$/ })).toHaveValue('system');
});

test('table row boxes include hairlines: density, compact class and coarse pointers', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery?compat');
  await ready(page);
  const table = page.locator('.gallery .table');
  await expect(table).toHaveCSS('border-collapse', 'collapse');
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
      // Rows breathe (44 px comfortable, 36 px compact); coarse pointers keep 44 px targets.
      const single = coarse ? 44 : dense ? 36 : 44;
      const two = coarse ? 60 : dense ? 52 : 64;
      const heights = await table
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(heights, `${density}, .compact=${compactClass}, coarse=${coarse}`).toEqual([
        single,
        two,
        single,
        two,
      ]);
      // Include the single-line last row with its transparent bottom border, too.
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
  let light: Awaited<ReturnType<typeof computedColors>> | undefined;
  for (const theme of ['light', 'dark']) {
    for (const target of [page, freshPage])
      await target.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
    const colors = await computedColors(page);
    expect(await computedColors(freshPage)).toEqual(colors);
    if (light) expect(colors).toEqual(light);
    else light = colors;
  }
});

test('table numbers and metrics stay tabular and mono cells share the table text size', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery?compat');
  await ready(page);
  const number = page.locator('.gallery .table td.num').first();
  await expect(number).toHaveCSS('font-variant-numeric', 'tabular-nums');
  // Exercise both frozen classes together on the same plugin-style table cell.
  await number.evaluate((cell) => cell.classList.add('mono'));
  await expect(number).toHaveCSS('font-family', /ui-monospace/);
  await expect(number).toHaveCSS('font-size', '13px');
  await expect(number).toHaveCSS('font-variant-numeric', 'tabular-nums');
  for (const route of ['jobs', 'resources', 'sources']) {
    await page.goto(`/?demo=true#/${route}`);
    await ready(page);
    const cells = page.locator('.table td.mono');
    // Logins and connections are mono; a job's time is now a worded duration.
    if (route === 'sources') expect(await cells.count()).toBeGreaterThan(0);
    for (const cell of await cells.all()) {
      await expect(cell).toHaveCSS('font-family', /ui-monospace/);
      await expect(cell).toHaveCSS('font-size', '13px');
    }
    for (const cell of await page.locator('.table td.num').all())
      await expect(cell).toHaveCSS('font-variant-numeric', 'tabular-nums');
  }
  await page.goto('/?demo=true#/overview');
  await ready(page);
  const metrics = page.locator('.stat-value');
  expect(await metrics.count()).toBeGreaterThan(0);
  for (const metric of await metrics.all())
    await expect(metric).toHaveCSS('font-variant-numeric', 'tabular-nums');
});

test('Plan keeps stacked cells unpadded and explanations attached to their options', async ({
  page,
}) => {
  await page.goto('/?demo=true#/plan');
  await ready(page);
  const options = page.locator('.plan-table .plan-option-row > td');
  const explanations = page.locator('.plan-table .plan-explanation-row > td');
  expect(await options.count()).toBeGreaterThan(0);
  expect(await explanations.count()).toBeGreaterThan(0);
  // Explanation rows start hidden behind their chevrons; judge layout from an option row.
  const stacked = await page
    .locator('.plan-table .plan-option-row')
    .first()
    .evaluate((row) => getComputedStyle(row).display === 'grid');
  if (stacked) {
    for (const cell of await page.locator('.plan-table td').all())
      await expect(cell).toHaveCSS('padding', '0px');
  }
  // Also cover table layout even when this project's viewport stacks the options.
  // The options that fit come first; those that do not fit sit in a second, closed table.
  await page
    .locator('.plan-options')
    .first()
    .evaluate((node) => {
      node.style.minWidth = '1100px';
    });
  await expect(page.locator('.plan-table .plan-option-row').first()).toHaveCSS(
    'display',
    'table-row',
  );
  // A closed option is a whole row with its own padding; an open one runs into its explanation.
  const first = page.locator('.plan-table .plan-option-row').first();
  for (const cell of await first.locator('> td').all())
    await expect(cell).not.toHaveCSS('padding-bottom', '0px');
  await first.locator('.plan-expand').click();
  for (const cell of await first.locator('> td').all())
    await expect(cell).toHaveCSS('padding-bottom', '0px');
  for (const cell of await explanations.all()) await expect(cell).toHaveCSS('padding-top', '0px');
});
