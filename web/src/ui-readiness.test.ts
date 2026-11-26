// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

it('exempts only marked gallery descendants, never live busy regions or core pages', async () => {
  vi.stubEnv('COMPUTEDECK_DEMO_NOW', '2026-01-15T14:00:00Z');
  const { busyRegions } = await import('../e2e/fixtures');
  document.body.innerHTML =
    '<main class="page-__gallery"><div class="gallery"><div data-static-sample><section aria-busy="true"></section></div></div></main>';
  expect(document.querySelectorAll(busyRegions)).toHaveLength(0);
  expect(document.querySelector('[aria-busy=true]')).not.toBeNull();
  const live = document.createElement('section');
  live.setAttribute('aria-busy', 'true');
  document.querySelector('.gallery')!.append(live);
  expect(document.querySelectorAll(busyRegions)).toHaveLength(1);
  for (const page of ['overview', 'jobs', 'resources', 'activity', 'settings']) {
    document.querySelector('main')!.className = `page-${page}`;
    expect(document.querySelectorAll(busyRegions)).toHaveLength(2);
  }
  document.querySelector('main')!.className = 'page-__gallery';
  document.querySelector('[data-static-sample]')!.setAttribute('aria-busy', 'true');
  expect(document.querySelectorAll(busyRegions)).toHaveLength(2);
});

it('reserves the static-sample marker for the component gallery', () => {
  const root = 'src';
  const users = readdirSync(root, { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === 'string' && /\.[jt]sx?$/.test(file) && !file.includes('.test.'),
    )
    .filter((file) => readFileSync(join(root, file), 'utf8').includes('data-static-sample'));
  expect(users).toEqual(['ui/DisplayGallery.tsx']);
});
