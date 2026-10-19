// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, download, upload } from './api';
import { ApiError, setLocale, t } from './i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  setLocale('en');
});

function stubFetch(response: Response) {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
    calls.push(init);
    return response;
  });
  return calls;
}

describe('api', () => {
  it('accepts empty replies', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(api('/session', { token: 'x' })).resolves.toBeUndefined();
  });
  it('turns error details into ApiError and never sends cookies', async () => {
    const calls = stubFetch(
      new Response(JSON.stringify({ detail: { code: 'token_invalid' } }), { status: 401 }),
    );
    const error = await api('/dashboard').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).detail).toEqual({ code: 'token_invalid' });
    expect(calls[0].credentials).toBe('omit');
  });
});

describe.each(['en', 'zh-CN'] as const)('example request isolation in %s', (locale) => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'post'])(
    'refuses %s with and without a body before fetch',
    async (method) => {
      setLocale(locale);
      window.history.replaceState(null, '', '/?demo=true');
      const calls = stubFetch(new Response('{}'));
      for (const body of [undefined, {}, null])
        await expect(api('/plugins/example/action', body, method)).rejects.toThrow(
          t('toast.demoReadOnly'),
        );
      expect(calls).toEqual([]);
    },
  );
  it('allows only the access-token check while other writes stay blocked', async () => {
    setLocale(locale);
    window.history.replaceState(null, '', '/?demo=true');
    const calls = stubFetch(new Response(JSON.stringify({ token: 'example-session' })));
    await expect(api('/session', { token: 'example-access-token' })).resolves.toEqual({
      token: 'example-session',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body as string)).toEqual({ token: 'example-access-token' });
    for (const path of ['/refresh', '/session/', '/session?extra=1', '/session-extra'])
      await expect(api(path, {})).rejects.toThrow(t('toast.demoReadOnly'));
    await expect(api('/session', {}, 'DELETE')).rejects.toThrow(t('toast.demoReadOnly'));
    expect(calls).toHaveLength(1);
  });
  it('refuses implicit POST and uploads, allows reads, and resumes writes when turned off', async () => {
    setLocale(locale);
    window.history.replaceState(null, '', '/?demo=true');
    const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      async () => new Response('{}'),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(api('/refresh', {})).rejects.toThrow(t('toast.demoReadOnly'));
    await expect(upload('/plugins/chat/attachments', new Blob(['file']))).rejects.toThrow(
      t('toast.demoReadOnly'),
    );
    expect(fetch).not.toHaveBeenCalled();
    await api('/dashboard?demo=true');
    await api('/health', undefined, 'GET');
    await download('/config');
    expect(fetch).toHaveBeenCalledTimes(3);
    window.history.replaceState(null, '', '/');
    await api('/plugins/chat/messages', {});
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('POST');
  });
  it('blocks a write if example mode is enabled while authentication is pending', async () => {
    const calls = stubFetch(new Response('{}'));
    const pending = api('/refresh', {});
    window.history.replaceState(null, '', '/?demo=true');
    await expect(pending).rejects.toThrow(t('toast.demoReadOnly'));
    expect(calls).toEqual([]);
  });
});
