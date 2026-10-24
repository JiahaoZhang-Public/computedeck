// @vitest-environment jsdom
import { act } from 'react';
import { createHmac, webcrypto } from 'node:crypto';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Puzzle } from 'lucide-react';
import App from './App';
import { api } from './api';
import { setToken } from './token';
import { registerWebPlugin } from './plugins';
import { corePages } from './routes';
import { serverDemo } from './test-server';
import { EMPTY_RULE } from './notify';
import { setLocale, t } from './i18n';

const data = serverDemo();
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const channel = { id: 'channel-1', name: 'Updates', kind: 'email', config: {} };

registerWebPlugin({
  id: 'example-test',
  pages: [
    {
      id: 'example-plugin',
      label: 'Plugin',
      icon: Puzzle,
      render: ({ request }) => (
        <button
          onClick={() => {
            void request('/plugins/example/save', {}, 'PUT').catch(() => undefined);
          }}
        >
          Save plugin
        </button>
      ),
    },
  ],
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  HTMLElement.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  window.localStorage.setItem('computedeck.chatName', 'alice');
  window.history.replaceState(null, '', '/?remote=1&demo=true');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => {
    let result: unknown = [];
    if (path.startsWith('/api/dashboard')) result = data;
    else if (path === '/api/marketplace') result = { marketplaces: [], plugins: [] };
    else if (path === '/api/settings') result = {};
    else if (path === '/api/health') result = { polling: true, plugins: {} };
    else if (path === '/api/toolbox')
      result = ['notify', 'chat'].map((id) => ({
        id,
        enabled: true,
        settings: [],
        values: {},
        secrets: [],
      }));
    else if (path === '/api/plugins/notify')
      result = {
        channels: [channel],
        rules: [{ ...EMPTY_RULE, id: 'rule-1', name: 'Failures', channels: [channel.id] }],
        kinds: [{ kind: 'email', label: { en: 'Email' }, fields: [] }],
        event_types: ['job.failed'],
        placeholders: [],
        log: [],
        ai_ready: false,
      };
    else if (path === '/api/plugins/chat')
      result = {
        channels: [{ id: 'general', label: 'General', kind: 'general' }],
        max_file_mb: 25,
      };
    else if (path.startsWith('/api/plugins/chat/messages'))
      result = [
        {
          id: 1,
          channel: 'general',
          at: new Date().toISOString(),
          author: 'bob',
          body: 'Ready',
          attachment: null,
        },
      ];
    return new Response(JSON.stringify(result));
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setToken('');
  setLocale('en');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(page: string, locale: 'en' | 'zh-CN' = 'en') {
  setLocale(locale);
  window.localStorage.setItem('computedeck.locale', locale);
  window.history.replaceState(null, '', `/?remote=1&demo=true#/${page}`);
  await act(async () => root.render(<App />));
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  );
}

function expectOnlyReads() {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  expect(
    fetchMock.mock.calls
      .map(([, init]) => init?.method ?? 'GET')
      .every((method) => method === 'GET'),
  ).toBe(true);
}

it.each([...corePages, 'example-plugin'])('keeps page actions read-only on %s', async (page) => {
  await open(page);
  expect(container.querySelector('.demo-banner')).not.toBeNull();
  // Exercise every initially rendered page/drawer action, including disabled controls.
  // The mode switch itself is exercised separately below.
  const buttons = [...container.querySelectorAll('main button, .topbar button')].filter(
    (item) => !item.closest('.demo-banner'),
  );
  expect(buttons.length).toBeGreaterThan(0);
  for (const item of buttons) {
    if (item.isConnected) await click(item);
  }
  expect(window.location.search).toContain('demo=true');
  expectOnlyReads();
});

it.each(['en', 'zh-CN'] as const)(
  'refuses Notify test, delete and editor saves in %s',
  async (locale) => {
    await open('notify', locale);
    expect(container.querySelector('.demo-banner')?.textContent).toContain(t('banner.demoTool'));
    await click(button(t('notify.test')));
    expect(container.textContent).toContain(t('toast.demoReadOnly'));
    for (const remove of container.querySelectorAll(`button[aria-label="${t('common.remove')}"]`))
      await click(remove);
    // Both rule and channel edits use the same real request function as the host.
    const edits = [...container.querySelectorAll(`button[aria-label="${t('common.configure')}"]`)];
    for (const edit of edits) {
      await click(edit);
      const form = container.querySelector('form.inline-editor')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(form.textContent).toContain(t('toast.demoReadOnly'));
      await click(button(t('common.cancel')));
    }
    expectOnlyReads();
  },
);

it.each(['en', 'zh-CN'] as const)(
  'refuses Chat send, delete and attachment upload in %s',
  async (locale) => {
    await open('chat', locale);
    await click(container.querySelector(`button[aria-label="${t('common.remove')}"]`));
    expect(container.textContent).toContain(t('toast.demoReadOnly'));
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Hello',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(t('chat.send')));
    expect(container.querySelector('.chat-compose')?.textContent).toContain(
      t('toast.demoReadOnly'),
    );
    const input = container.querySelector('input[type=file]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [new File(['notes'], 'notes.txt')] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button(t('chat.send')));
    expect(container.querySelector('.chat-compose')?.textContent).toContain(
      t('toast.demoReadOnly'),
    );
    expectOnlyReads();
  },
);

it('preserves other query parameters and the route when toggling and reloading', async () => {
  await open('jobs');
  await click(button(t('banner.demoOff')));
  expect(window.location.search).toBe('?remote=1');
  expect(window.location.hash).toBe('#/jobs');
  expect(container.querySelector('.demo-banner')).toBeNull();
  await click(container.querySelector('input[role=switch]'));
  expect(window.location.search).toBe('?remote=1&demo=true');
  expect(window.location.hash).toBe('#/jobs');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<App />));
  expect(container.querySelector('.demo-banner')?.textContent).toContain(t('banner.demo'));
  expectOnlyReads();
});

it.each(['en', 'zh-CN'] as const)(
  'omits the example source count from Settings in %s',
  async (locale) => {
    await open('settings', locale);
    expect(container.textContent).toContain(t('settings.sourcesMovedExample'));
    expect(container.textContent).not.toContain(
      t('settings.sourcesMoved', { count: data.sources.length }),
    );
    await click(button(t('banner.demoOff')));
    expect(container.textContent).toContain(
      t('settings.sourcesMoved', { count: data.sources.length }),
    );
  },
);

it.each([
  ['diagnosis', '#attention button'],
  ['drawer', '.jobs-table tbody tr'],
  ['health panel', '.health-pill'],
])('closes the %s when leaving example mode', async (kind, selector) => {
  await open(kind === 'drawer' ? 'jobs' : 'overview');
  await click(container.querySelector(selector));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await click(button(t('banner.demoOff')));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('.demo-banner')).toBeNull();
  expectOnlyReads();
});

it.each(['en', 'zh-CN'] as const)(
  'unlocks the token gate without leaving example mode in %s',
  async (locale) => {
    vi.stubGlobal('crypto', webcrypto);
    const read = fetchMock.getMockImplementation()!;
    let unlocked = false;
    let dashboardLoaded!: () => void;
    const authenticatedDashboard = new Promise<void>((resolve) => {
      dashboardLoaded = resolve;
    });
    fetchMock.mockImplementation(async (path: string, init: RequestInit) => {
      if (path === '/api/session') {
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ token: 'example-access-token' });
        unlocked = true;
        return new Response(JSON.stringify({ token: 'example-session' }));
      }
      if (path.startsWith('/api/ping?')) {
        const challenge = new URL(path, window.location.origin).searchParams.get(
          'session_challenge',
        );
        const proof = createHmac('sha256', 'example-session')
          .update(`computedeck-browser:${challenge}`)
          .digest('hex');
        return new Response(JSON.stringify({ session_proof: proof }));
      }
      if (path.startsWith('/api/dashboard')) {
        if (!unlocked) return new Response('{}', { status: 401 });
        expect(new Headers(init.headers).get('X-ComputeDeck-Token')).toBe('example-session');
        dashboardLoaded();
      }
      return read(path, init);
    });
    await open('overview', locale);
    const input = container.querySelector('.token-gate input')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'example-access-token',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(t('token.save')));
    await act(async () => authenticatedDashboard);
    expect(unlocked).toBe(true);
    expect(container.querySelector('.token-gate')).toBeNull();
    expect(container.querySelector('.demo-banner')).not.toBeNull();
    expect(window.location.search).toContain('demo=true');
    expect(container.querySelector('.health-age')?.textContent).toBe(
      t('time.hoursAgo', { count: 2 }),
    );
    await expect(api('/refresh', {})).rejects.toThrow(t('toast.demoReadOnly'));
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('/api/session');
  },
);
