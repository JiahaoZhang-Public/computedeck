import { existsSync } from 'node:fs';
import { defineConfig, webkit } from '@playwright/test';

const combos = [
  { width: 375, locale: 'en', colorScheme: 'light' },
  { width: 375, locale: 'zh-CN', colorScheme: 'dark' },
  { width: 900, locale: 'en', colorScheme: 'dark' },
  { width: 900, locale: 'zh-CN', colorScheme: 'light' },
  { width: 1280, locale: 'en', colorScheme: 'light' },
  { width: 1280, locale: 'zh-CN', colorScheme: 'dark' },
] as const;
const hasWebKit = existsSync(webkit.executablePath());
if (!process.env.CI && !hasWebKit) console.log('WebKit not installed — skipped');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 4 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixels: 0, threshold: 0 } },
  // Missing baselines fail too. Creation/replacement always needs an explicit command.
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/snapshots/{platform}/{projectName}/{testFilePath}/{arg}{ext}',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    ...combos.map(({ width, locale, colorScheme }) => ({
      name: `chromium-${width}-${locale}-${colorScheme}`,
      use: {
        browserName: 'chromium' as const,
        channel: process.env.PLAYWRIGHT_CHANNEL,
        launchOptions: { args: ['--disable-gpu', '--disable-partial-raster'] },
        viewport: { width, height: 800 },
        hasTouch: width === 375,
        locale,
        colorScheme,
      },
    })),
    // F6 adds *.overlays.spec.ts; its Chromium coverage uses the same six projects above.
    ...(process.env.CI || hasWebKit
      ? combos.map(({ width, locale, colorScheme }) => ({
          name: `webkit-${width}-${locale}-${colorScheme}`,
          testMatch: ['**/*.overlays.spec.ts', '**/theme.spec.ts'],
          use: {
            browserName: 'webkit' as const,
            viewport: { width, height: 800 },
            hasTouch: width === 375,
            locale,
            colorScheme,
          },
        }))
      : []),
  ],
});
