import type { Page, TestInfo } from '@playwright/test';

export function screenshotOptions(page: Page) {
  return {
    fullPage: true,
    animations: 'disabled' as const,
    // Only Settings → Service → Address: the temporary service has a random port.
    mask: [page.locator('.page-settings .kv > div > dd.mono')],
    maskColor: '#808080',
  };
}

export async function settledScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const options = screenshotOptions(page);
  let current = await page.screenshot(options);
  let previous = current;
  for (let attempt = 2; attempt <= 5; attempt++) {
    previous = current;
    current = await page.screenshot(options);
    if (current.equals(previous)) return current;
  }
  await testInfo.attach(`${name}-unsettled-previous`, { body: previous, contentType: 'image/png' });
  await testInfo.attach(`${name}-unsettled-current`, { body: current, contentType: 'image/png' });
  throw new Error(
    `${name}: full-page screenshot did not settle after 5 captures (two consecutive byte-identical captures required)`,
  );
}
