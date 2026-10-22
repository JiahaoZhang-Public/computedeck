// Run with Playwright installed, or set PLAYWRIGHT_MODULE to its module path.
// No server or live connections: the browser receives only the bundled demo fixture.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const web = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  execFileSync(
    path.join(web, '../.venv/bin/python'),
    ['-c', 'import json; from computedeck.demo import dashboard; print(json.dumps(dashboard()))'],
    { encoding: 'utf8' },
  ),
);
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { PlanPage } from './src/pages/Plan';
      import { CloudPage } from './src/pages/Cloud';
      import { groupsOf } from './src/groups';
      import { setLocale } from './src/i18n';
      const data = ${JSON.stringify(data)};
      setLocale(document.documentElement.lang);
      const Page = location.hash.startsWith('#/cloud') ? CloudPage : PlanPage;
      createRoot(document.querySelector('main')).render(<Page ctx={{
        data, groups: groupsOf(data), demo: true, copy: async () => {},
        group: 'all', query: '', serverName: 'Example server',
        searchRef: { current: null }, setQuery: () => {}, setGroup: () => {},
      }} />);
    `,
    resolveDir: web,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = readFileSync(path.join(web, 'src/styles.css'), 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
try {
  for (const locale of ['en', 'zh-CN'])
    for (const width of [375, 900, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('https://computedeck.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html lang="${locale}"><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${css}
          main.content { margin: 0 auto; padding: 16px; max-width: 1052px; }
        </style><main class="content page-plan"></main></html>`,
        }),
      );
      await page.goto('https://computedeck.test/#/plan?model=A100%2080GB');
      await page.addScriptTag({ content: outputFiles[0].text });
      await page.locator('.plan-table').first().waitFor();
      assert.ok(await page.locator('.plan-submit .sub').count(), 'model-copy note is rendered');
      for (const expanded of [false, true]) {
        if (expanded)
          await page.locator('.plan-explanation').evaluateAll((nodes) => {
            nodes.forEach((node) => {
              node.open = true;
            });
          });
        const dimensions = await page
          .locator('.plan-options')
          .first()
          .evaluate((wrapper) => ({
            wrapper: wrapper.clientWidth,
            table: wrapper.querySelector('table').scrollWidth,
            page: document.documentElement.scrollWidth,
            viewport: innerWidth,
          }));
        if (width === 1280) assert.equal(dimensions.wrapper, 1018, 'desktop plan wrapper');
        assert.ok(
          dimensions.table <= dimensions.wrapper + 1,
          JSON.stringify({ locale, width, expanded, dimensions }),
        );
        assert.ok(dimensions.page <= dimensions.viewport, 'page fits viewport');
        const pairs = await page
          .locator('.plan-options')
          .first()
          .locator('.plan-option-row')
          .evaluateAll((rows) =>
            rows.map((row) => {
              const next = row.nextElementSibling;
              return {
                adjacent: next?.classList.contains('plan-explanation-row'),
                cellBorders: [...row.cells].map((cell) => getComputedStyle(cell).borderBottomWidth),
                rowBorder: getComputedStyle(row).borderBottomWidth,
                gap: next.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
                separator: Math.max(
                  parseFloat(getComputedStyle(next).borderBottomWidth),
                  ...[...next.cells].map((cell) =>
                    parseFloat(getComputedStyle(cell).borderBottomWidth),
                  ),
                ),
                hasNext: !!next.nextElementSibling,
              };
            }),
          );
        assert.ok(pairs.length > 0);
        for (const pair of pairs) {
          assert.equal(pair.adjacent, true, 'explanation immediately follows its option');
          assert.ok(
            pair.cellBorders.every((border) => border === '0px'),
            'no rule under option cells',
          );
          assert.equal(pair.rowBorder, '0px', 'no rule under option card');
          assert.ok(Math.abs(pair.gap) <= 1, 'no gap between option and explanation');
          if (pair.hasNext) assert.ok(pair.separator > 0, 'separator follows the explanation');
        }
      }
      const heights = await page
        .locator('.plan-presets button')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
      assert.ok(
        heights.every((height) => height >= (width <= 560 ? 44 : 26)),
        'preset tap targets',
      );
      console.log(`PASS plan layout ${locale} ${width}px, collapsed and expanded`);
      await page.close();
    }
  for (const locale of ['en', 'zh-CN'])
    for (const wrapperWidth of [1018, 950]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route('https://computedeck.test/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html lang="${locale}"><meta charset="utf-8">
        <style>${css}
          main.content { margin: 0 auto; padding: 16px; width: ${wrapperWidth + 34}px; }
        </style><main class="content page-cloud"></main></html>`,
        }),
      );
      await page.goto('https://computedeck.test/#/cloud');
      await page.addScriptTag({ content: outputFiles[0].text });
      await page.locator('.cloud-price').first().waitFor();
      const dimensions = await page.locator('.table-wrap').evaluate((wrapper) => ({
        wrapper: wrapper.clientWidth,
        table: wrapper.querySelector('table').scrollWidth,
      }));
      assert.equal(dimensions.wrapper, wrapperWidth, 'exercise the actual desktop wrapper width');
      assert.ok(dimensions.table <= dimensions.wrapper + 1, JSON.stringify({ locale, dimensions }));
      const cells = await page.locator('.cloud-price, .cloud-sampled').evaluateAll((cells) =>
        cells.map((cell) => {
          const broken = [];
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            // Keep Latin words, prices, and closing punctuation attached within either locale.
            for (const match of node.textContent.matchAll(/[A-Za-z0-9$€()./:≥≈-]+|[^\s][)）]/g)) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              if (new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1)
                broken.push(match[0]);
            }
          }
          return {
            sampled: cell.classList.contains('cloud-sampled'),
            whiteSpace: getComputedStyle(cell).whiteSpace,
            overflowWrap: getComputedStyle(cell).overflowWrap,
            broken,
          };
        }),
      );
      for (const cell of cells) {
        assert.deepEqual(cell.broken, [], 'no split words, prices or closing punctuation');
        if (cell.sampled) assert.equal(cell.whiteSpace, 'nowrap');
        else assert.equal(cell.overflowWrap, 'normal');
      }
      console.log(`PASS cloud layout ${locale} ${wrapperWidth}px wrapper`);
      await page.close();
    }
} finally {
  await browser.close();
}
