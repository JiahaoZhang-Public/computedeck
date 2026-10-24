import type { Page, TestInfo } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { settledScreenshot } from '../e2e/screenshots';

function captures(images: string[]) {
  const screenshot = vi.fn();
  for (const image of images) screenshot.mockResolvedValueOnce(Buffer.from(image));
  const page = { screenshot, locator: vi.fn() } as unknown as Page;
  const attach = vi.fn();
  const testInfo = { attach } as unknown as TestInfo;
  return { page, testInfo, screenshot, attach };
}

it('accepts two consecutive byte-identical captures', async () => {
  const { page, testInfo, screenshot } = captures(['stable', 'stable']);
  expect(await settledScreenshot(page, testInfo, 'first')).toEqual(Buffer.from('stable'));
  expect(screenshot).toHaveBeenCalledTimes(2);
});

it('discards a single torn capture before comparing contexts', async () => {
  const { page, testInfo, screenshot } = captures(['torn', 'stable', 'stable']);
  expect(await settledScreenshot(page, testInfo, 'second')).toEqual(Buffer.from('stable'));
  expect(screenshot).toHaveBeenCalledTimes(3);
});

it('fails after five captures without a consecutive match and attaches the last pair', async () => {
  const { page, testInfo, screenshot, attach } = captures(['a', 'b', 'a', 'b', 'a']);
  await expect(settledScreenshot(page, testInfo, 'first')).rejects.toThrow(
    'did not settle after 5 captures',
  );
  expect(screenshot).toHaveBeenCalledTimes(5);
  expect(attach.mock.calls.map(([, options]) => options.body)).toEqual([
    Buffer.from('b'),
    Buffer.from('a'),
  ]);
});
