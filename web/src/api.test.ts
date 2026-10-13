import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ApiError } from './i18n';

afterEach(() => vi.unstubAllGlobals());

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
