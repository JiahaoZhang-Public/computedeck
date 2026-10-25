import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { test, expect, ready, demoNow, fontGuard } from './fixtures';
import { checkFocus, focusObstructions } from './checks';
import en from '../src/locales/en';
import zh from '../src/locales/zh-CN';

const words = (locale?: string) =>
  locale === 'zh-CN'
    ? {
        panel: '打开示例面板',
        form: '打开示例表单',
        remove: '移除示例',
        keep: '保留',
        menu: '更多操作',
        toast: '显示三条通知',
        close: '关闭',
        cancel: '取消',
        next: '下一步',
        pop: '关于此示例',
        undo: '撤销',
      }
    : {
        panel: 'Open example panel',
        form: 'Open example form',
        remove: 'Remove example',
        keep: 'Keep',
        menu: 'More actions',
        toast: 'Show three notifications',
        close: 'Close',
        cancel: 'Cancel',
        next: 'Next step',
        pop: 'About this example',
        undo: 'Undo',
      };
async function audit(page: Page, layer: Locator) {
  // Audit only the new layer: unrelated 0.7 findings remain in ui.spec's reviewed baseline.
  await layer.evaluate((node) => node.setAttribute('data-layer-audit', ''));
  const result = await new AxeBuilder({ page })
    .include('[data-layer-audit]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  await layer.evaluate((node) => node.removeAttribute('data-layer-audit'));
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await checkFocus(page);
}
async function contained(page: Page, dialog: Locator) {
  const controls = dialog
    .locator('button, input, select, textarea, a[href]')
    .filter({ visible: true });
  const count = await controls.count();
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
}

test('C1 panel: heading focus, responsive inertness, Escape/Back and cold links', async ({
  page,
  locale,
  viewport,
  browserName,
}) => {
  const w = words(locale);
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  if (browserName === 'chromium') await fontGuard(page, locale);
  const trigger = page.getByRole('button', { name: w.panel, exact: true });
  await trigger.click();
  const layer = page.locator('.context-panel, dialog.drawer');
  await expect(layer).toBeVisible();
  await expect(layer.getByRole('heading', { name: 'build-small' })).toBeFocused();
  if (viewport!.width >= 1200) {
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.keyboard.press('j');
    await expect(layer.getByRole('heading', { name: 'train-small' })).toBeFocused();
    await page.keyboard.press('k');
    await expect(layer.getByRole('heading', { name: 'build-small' })).toBeFocused();
    await trigger.focus();
    await expect(trigger).toBeFocused();
  } else {
    expect(await layer.evaluate((node) => node.matches(':modal'))).toBe(true);
    await trigger.evaluate((node: HTMLElement) => node.focus());
    await expect(trigger).not.toBeFocused();
    await contained(page, layer);
  }
  await audit(page, layer);
  await expect(page).toHaveScreenshot('context-panel.png', {
    fullPage: false,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.goBack();
  await expect(layer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goto('/?demo=true#/__gallery?section=panel');
  await ready(page);
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  await expect(page).toHaveURL(/#\/__gallery$/);
});

test('C1 focus view and nested confirmation: safe focus, no backdrop dismissal, one Escape at a time', async ({
  page,
  locale,
}) => {
  const w = words(locale);
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  const trigger = page.getByRole('button', { name: w.form, exact: true });
  await trigger.click();
  const form = page.locator('dialog.focus-view');
  await expect(form).toBeVisible();
  await expect(form.getByRole('button', { name: w.cancel, exact: true })).toBeFocused();
  await contained(page, form);
  await audit(page, form);
  await form.getByRole('button', { name: w.next }).click();
  await expect(page).toHaveURL(/step=2/);
  await form.getByRole('button', { name: w.remove, exact: true }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await expect(confirm.getByRole('button', { name: w.keep })).toBeFocused();
  expect(await confirm.evaluate((node) => node.matches(':modal'))).toBe(true);
  await audit(page, confirm);
  await page.mouse.click(2, 2);
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(form.getByRole('button', { name: w.remove, exact: true })).toBeFocused();
  await page.goBack();
  await expect(form).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('C1 menu and popover: keyboard, outside click, focus return and transient URLs', async ({
  page,
  locale,
  hasTouch,
}) => {
  const w = words(locale);
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  const url = page.url();
  const trigger = page.getByRole('button', { name: w.menu, exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  if (!hasTouch) {
    const anchor = (await trigger.boundingBox())!;
    const box = (await page.locator('.layer-popover').boundingBox())!;
    expect(
      box.y + box.height <= anchor.y || box.y >= anchor.y + anchor.height,
      'The menu must flip rather than cover its trigger',
    ).toBe(true);
  }
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await audit(
    page,
    hasTouch ? page.locator('dialog.touch-popover') : page.locator('.layer-popover'),
  );
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(url);
  const pop = page.getByRole('button', { name: w.pop, exact: true });
  await pop.click();
  const floating = page.locator('.layer-popover, .touch-popover');
  await expect(floating).toBeVisible();
  if (!hasTouch) {
    await page.mouse.click(1, 1);
    await expect(floating).toHaveCount(0);
  } else {
    await page.keyboard.press('Escape');
    await expect(floating).toHaveCount(0);
  }
  await expect(page).toHaveURL(url);
  await expect(pop).toBeFocused();
  if (!hasTouch) {
    // Text inputs take pointer focus in both engines, including Safari's default
    // keyboard mode. Clicking a real outside control must retain that behaviour.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'outside-focus-control';
      input.setAttribute('aria-label', 'Outside focus control');
      input.style.cssText = 'position:fixed;left:12px;top:12px;width:140px;z-index:100';
      document.body.append(input);
    });
    await pop.click();
    await expect(floating).toBeVisible();
    const outside = page.getByRole('textbox', { name: 'Outside focus control' });
    await outside.click();
    await expect(floating).toHaveCount(0);
    await expect(outside).toBeFocused();
    await page.keyboard.type('kept');
    await expect(outside).toHaveValue('kept');
    await outside.evaluate((node) => node.remove());
    await expect(page).toHaveURL(url);
  }
});

test('C18 three toasts: modal host, Undo pause, persistent error and Escape without focus movement', async ({
  page,
  locale,
}) => {
  const w = words(locale);
  await page.clock.install({ time: new Date(demoNow) });
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.getByRole('button', { name: w.form, exact: true }).click();
  const form = page.locator('dialog.focus-view');
  await form.getByRole('button', { name: w.toast, exact: true }).click();
  const stack = form.locator('.toasts');
  await expect(stack).toHaveAttribute('role', 'status');
  await expect(stack.locator('.toast')).toHaveCount(3);
  // A mouse click in WebKit can leave focus on the modal host. It must not
  // move notifications over the heading and first field.
  const stackBox = (await stack.boundingBox())!;
  expect(stackBox.y).toBeGreaterThan(page.viewportSize()!.height / 2);
  expect(await stack.evaluate((node) => (node as HTMLElement).style.top)).toBe('');
  await expect(page).toHaveScreenshot('modal-toasts.png', {
    fullPage: false,
    animations: 'disabled',
  });
  const undo = stack.getByRole('button', { name: w.undo, exact: true });
  await undo.focus();
  await page.clock.runFor(11000);
  await expect(undo).toBeVisible();
  await expect(stack.locator('.toast.error')).toHaveCount(1);
  await page.clock.resume();
  await audit(page, stack);

  await page.keyboard.press('Meta+z');
  await expect(undo).toHaveCount(0);
  const safe = form.getByRole('button', { name: w.cancel, exact: true });
  await safe.focus();
  await page.keyboard.press('Escape');
  await expect(stack.locator('.toast')).toHaveCount(0);
  await expect(safe).toBeFocused();
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  const errorRow = page.locator('.layer-errors > div');
  await expect(errorRow.locator('.status-shape.severity-error')).toBeVisible();
  await expect(errorRow.locator('time')).toHaveAttribute('datetime', /T/);
});

// Keep this table aligned with the addresses in configuration.md. IDs are real
// demo records; the two final entries exercise unavailable edit/repair targets.
const addresses = [
  { route: 'sources?source=example:cluster-a-alice', kind: 'panel', heading: 'diagnosis' },
  { route: 'sources?add=source&step=1', kind: 'focus', heading: 'addSource' },
  { route: 'sources?add=ssh&step=2', kind: 'focus', heading: 'sshForm' },
  { route: 'cloud?add=instance&step=1', kind: 'focus', heading: 'addInstance' },
  { route: 'sources?edit=example:cluster-a-alice&step=2', kind: 'focus', heading: 'source' },
  { route: 'sources?edit=example:cluster-a-alice&step=3', kind: 'focus', heading: 'check' },
  {
    route: 'cloud?edit=example:manual:lab-workstation-devbox&step=1',
    kind: 'focus',
    heading: 'instance',
  },
  { route: 'sources?repair=example:cluster-a-alice', kind: 'focus', heading: 'diagnosis' },
  { route: 'cloud?section=ssh', kind: 'focus', heading: 'ssh' },
  { route: 'toolbox?plugin=notify', kind: 'panel', heading: 'tool' },
  { route: 'toolbox?plugin=notify&edit=notify&step=1', kind: 'focus', heading: 'settings' },
  { route: 'toolbox?tab=market&plugin=example-tool%40example', kind: 'panel', heading: 'market' },
  { route: 'sources?edit=missing-source&step=2', kind: 'focus', heading: 'missing' },
  { route: 'sources?repair=missing-source', kind: 'focus', heading: 'missingSource' },
] as const;
const overlayKeys = ['add', 'edit', 'repair', 'step', 'section', 'source', 'plugin'];
for (const address of addresses) {
  test(`documented layer address: ${address.route}`, async ({ page, locale, viewport }) => {
    const labels = locale === 'zh-CN' ? zh : en;
    const headings = {
      diagnosis: labels['attention.diagnosis'].replace('{name}', 'Cluster A'),
      addSource: labels['source.add'],
      sshForm: locale === 'zh-CN' ? 'GPU 机器（SSH）' : 'GPU machine (SSH)',
      addInstance: labels['instance.form.add'],
      source: 'Cluster A',
      check: labels['source.check.title'].replace('{name}', 'Cluster A'),
      instance: labels['instance.form.edit'].replace('{name}', 'dev-box'),
      ssh: labels['ssh.title'],
      tool: locale === 'zh-CN' ? '任务提醒' : 'Notifications',
      settings: `${labels['toolbox.settings']} · ${locale === 'zh-CN' ? '任务提醒' : 'Notifications'}`,
      market: locale === 'zh-CN' ? '示例工具' : 'Example tool',
      missing: labels['drawer.unavailable'],
      missingSource: labels['msg.source_not_found'],
    };
    await marketplaceFixture(page);
    const [path, query] = address.route.split('?');
    const addressed = new URLSearchParams(query);
    addressed.set('q', 'kept');
    addressed.set('group', 'all');
    const base = new URLSearchParams(addressed);
    for (const key of overlayKeys) base.delete(key);
    const baseHash = `#/${path}?${base}`;
    const hash = `#/${path}?${addressed}`;
    const layer = page.locator(
      address.kind === 'focus'
        ? 'dialog.focus-view'
        : viewport!.width >= 1200
          ? '.context-panel'
          : 'dialog.drawer',
    );
    const assertOpen = async () => {
      await expect(layer).toBeVisible();
      await expect(
        layer.getByRole('heading', { name: headings[address.heading], exact: true }),
      ).toBeVisible();
      if (address.kind === 'focus' || viewport!.width < 1200)
        expect(await layer.evaluate((node) => node.matches(':modal'))).toBe(true);
      else await expect(layer).not.toHaveAttribute('aria-modal');
      if (address.kind === 'panel' && address.heading === 'diagnosis')
        await expect(layer.locator('h2').first()).toBeFocused();
      if (address.heading === 'check') {
        await expect(
          layer.getByRole('button', { name: labels['source.check.run'], exact: true }),
        ).toBeVisible();
        await expect(layer).not.toContainText(labels['source.check.savedPending']);
      }
    };
    const assertClosed = async () => {
      await expect(page.locator('.context-panel, dialog[open]')).toHaveCount(0);
      await expect(page).toHaveURL(`/?demo=true${baseHash}`);
      const params = new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]);
      for (const key of overlayKeys) expect(params.has(key), key).toBe(false);
      expect(params.get('q')).toBe('kept');
      expect(params.get('group')).toBe('all');
    };
    await page.goto(`/?demo=true${hash}`);
    await ready(page);
    await assertOpen();
    await page.keyboard.press('Escape');
    // Settings is nested over its addressed tool panel; Escape closes one layer at a time.
    if (address.heading === 'settings') {
      await expect(page.locator('dialog.focus-view')).toHaveCount(0);
      await expect(page.locator('.context-panel, dialog.drawer')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await assertClosed();
    await page.goto(`/?demo=true${baseHash}`);
    await ready(page);
    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, hash);
    await assertOpen();
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    await page.goBack();
    await assertClosed();
  });
}

async function marketplaceFixture(page: Page) {
  await page.route('**/api/marketplace', (route) =>
    route.fulfill({
      json: {
        policy_error: null,
        marketplaces: [
          {
            name: 'example',
            kind: 'local',
            source: 'example.test',
            tier: 'local',
            updated_at: demoNow,
            plugins: 1,
          },
        ],
        plugins: [
          {
            name: 'example-tool',
            display_name: { en: 'Example tool', 'zh-CN': '示例工具' },
            description: null,
            version: '1.0',
            category: null,
            tags: [],
            permissions: [],
            requires: null,
            homepage: null,
            license: null,
            author: null,
            source_type: 'pypi',
            marketplace: 'example',
            tier: 'local',
            installed_version: null,
            update: false,
            compatible: true,
            blocked: false,
            command: 'computedeck plugin install example-tool@example',
          },
        ],
      },
    }),
  );
}

test('tool and marketplace panels have reloadable URLs and close with Back', async ({ page }) => {
  await marketplaceFixture(page);
  for (const route of ['toolbox', 'toolbox?tab=market']) {
    await page.goto(`/?demo=true#/${route}`);
    await ready(page);
    const tile = page.locator('.tool-tile-main').first();
    await expect(tile).toBeVisible();
    await tile.click();
    const panel = page.locator('.context-panel, dialog.drawer');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/[?&]plugin=/);
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(tile).toBeFocused();
    await tile.click();
    await page.reload();
    await ready(page);
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]plugin=/);
  }
});

test('C1 resizing a panel retains its subject and original focus-return target', async ({
  page,
  locale,
}) => {
  const w = words(locale);
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  const opener = page.getByRole('button', { name: w.panel, exact: true });
  await opener.click();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('dialog.drawer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'build-small' })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.context-panel')).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
});

test('phone detail actions stay reachable and scroll padding covers the actual action bar', async ({
  page,
  viewport,
}) => {
  await page.goto('/?demo=true#/jobs?state=pending&job=example%3Acluster-a%3A48214');
  await ready(page);
  const panel = page.locator('.context-panel, dialog.drawer');
  await expect(panel).toBeVisible();
  const actions = panel.locator('.drawer-actions').first();
  await expect(actions).toBeVisible();
  if (viewport!.width < 600) {
    expect(await actions.evaluate((node) => getComputedStyle(node).position)).toBe('sticky');
    for (const end of [false, true]) {
      await panel.evaluate((node, end) => {
        node.scrollTop = end ? node.scrollHeight : 0;
      }, end);
      await expect(actions).toBeInViewport();
      const padding = await panel.evaluate((node) =>
        parseFloat(getComputedStyle(node).scrollPaddingBottom),
      );
      expect(padding).toBeGreaterThanOrEqual((await actions.boundingBox())!.height + 8);
    }
  }
  await checkFocus(page);
});

test('focus visibility probe still reports a control covered by a fixed element', async ({
  page,
}) => {
  await page.goto('/?demo=true#/__gallery');
  await ready(page);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'focus-probe';
    button.textContent = 'Covered focus probe';
    button.style.cssText = 'position:fixed;left:4px;top:4px;width:100px;height:44px;z-index:1000';
    const cover = document.createElement('div');
    cover.id = 'focus-cover';
    cover.style.cssText =
      'position:fixed;left:0;top:0;width:120px;height:60px;z-index:1001;background:var(--bg-surface)';
    document.body.append(button, cover);
  });
  expect(await focusObstructions(page)).toContain('Covered focus probe');
  await page.locator('#focus-cover').evaluate((node) => node.remove());
  expect(await focusObstructions(page)).not.toContain('Covered focus probe');
});

test('source Next replaces step 1 so one Back from step 2 closes the form', async ({
  page,
  locale,
}) => {
  await page.goto('/?demo=true#/sources?q=kept');
  await ready(page);
  const baseLength = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    location.hash = '#/sources?q=kept&add=source&step=1';
  });
  const form = page.locator('dialog.focus-view');
  await expect(form).toBeVisible();
  // Choosing a type is the existing source form's Next transition (no write or draft test).
  await form.getByRole('button', { name: /GPU machine \(SSH\)|GPU 机器（SSH）/ }).click();
  await expect(
    form.getByRole('heading', {
      name: locale === 'zh-CN' ? 'GPU 机器（SSH）' : 'GPU machine (SSH)',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/step=2/);
  expect(await page.evaluate(() => history.length)).toBe(baseLength + 1);
  await page.goBack();
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL('/?demo=true#/sources?q=kept');
});

for (const route of ['jobs?state=pending', 'cloud?q=box']) {
  test(`beside j/k follows displayed rows in both directions: ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?demo=true#/${route}`);
    await ready(page);
    const rows = page.locator('main [data-detail-key]');
    const shown = await rows.evaluateAll((nodes) =>
      nodes.map((node) => ({
        key: (node as HTMLElement).dataset.detailKey!,
        id: (node as HTMLElement).dataset.detailId!,
        name: node.querySelector('strong')!.textContent!,
      })),
    );
    expect(shown).toHaveLength(route.startsWith('jobs') ? 3 : 2);
    if (route.startsWith('jobs')) expect(shown.at(-1)!.key).toBe('array');
    await rows.first().click();
    const length = await page.evaluate(() => history.length);
    const panel = page.locator('.context-panel');
    const geometry = await panel.evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
      width: node.getBoundingClientRect().width,
      barBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      panelWidth: parseFloat(getComputedStyle(node).getPropertyValue('--panel-w')),
    }));
    expect(geometry.top).toBe(geometry.barBottom);
    expect(geometry.bottom).toBe(800);
    expect(geometry.width).toBe(geometry.panelWidth);
    const selected = async (index: number) => {
      await expect(panel.locator('#detail-title')).toContainText(shown[index].name);
      const params = new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]);
      expect(params.get(shown[index].key)).toBe(shown[index].id);
      expect(await page.evaluate(() => history.length)).toBe(length);
    };
    await selected(0);
    await page.keyboard.press('k');
    await selected(0);
    for (let index = 1; index < shown.length; index++) {
      await page.keyboard.press('j');
      await selected(index);
    }
    await page.keyboard.press('j');
    await selected(shown.length - 1);
    for (let index = shown.length - 2; index >= 0; index--) {
      await page.keyboard.press('k');
      await selected(index);
    }
    if (route.startsWith('jobs')) {
      for (const shortcut of ['Meta+k', 'Control+k']) {
        await panel.locator('#detail-title').focus();
        await page.keyboard.press(shortcut);
        await expect(page.locator('main .search input')).toBeFocused();
        await expect(panel).toBeVisible();
      }
    }
    await panel.locator('#detail-title').focus();
    await page.keyboard.press('j');
    await selected(1);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(rows.nth(1)).toBeFocused();
    await expect(page).toHaveURL(`/?demo=true#/${route}`);
    await rows.first().click();
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(`/?demo=true#/${route}`);
  });
}

test('health pill anchors its popover and regains focus after Escape', async ({
  page,
  hasTouch,
}) => {
  await page.goto('/?demo=true#/jobs');
  await ready(page);
  const pill = page.locator('.health-pill');
  await pill.click();
  const popover = page.locator('.layer-popover, .touch-popover');
  await expect(popover).toBeVisible();
  if (!hasTouch) {
    const anchor = (await pill.boundingBox())!;
    const box = (await popover.boundingBox())!;
    expect(box.y >= anchor.y + anchor.height || box.y + box.height <= anchor.y).toBe(true);
    expect(box.x < anchor.x + anchor.width && box.x + box.width > anchor.x).toBe(true);
  } else {
    expect(await popover.evaluate((node) => node.matches(':modal'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(pill).toBeFocused();
});

for (const closing of ['Escape', 'button'] as const) {
  test(`beside panel retains edited filters on close with ${closing}`, async ({ page, locale }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?demo=true#/jobs');
    await ready(page);
    const row = page.locator('main [data-detail-key="job"]').filter({ visible: true }).first();
    await row.click();
    const panel = page.locator('.context-panel');
    await expect(panel).toBeVisible();
    const search = page.locator('main .search input');
    await search.fill('train');
    if (closing === 'Escape') await search.press('Escape');
    else await panel.getByRole('button', { name: words(locale).close, exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(search).toHaveValue('train');
    await expect(page).toHaveURL(/#\/jobs\?q=train$/);
    await row.click();
    await expect(panel).toBeVisible();
    await page.goBack();
    await expect(panel).toHaveCount(0);
    await expect(search).toHaveValue('train');
  });
}

test('Toolbox tab changes clear the addressed plugin and settings', async ({ page, locale }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await marketplaceFixture(page);
  await page.goto('/?demo=true#/toolbox?plugin=notify');
  await ready(page);
  const labels = locale === 'zh-CN' ? zh : en;
  await page.getByRole('tab', { name: labels['toolbox.market'], exact: true }).click();
  await expect(page).toHaveURL(/#\/toolbox\?tab=market$/);
  await expect(page.locator('.context-panel, dialog[open]')).toHaveCount(0);
  await page.getByRole('tab', { name: new RegExp(labels['toolbox.installed']) }).click();
  await expect(page).toHaveURL(/#\/toolbox$/);
  await expect(page.locator('.context-panel, dialog[open]')).toHaveCount(0);
});
