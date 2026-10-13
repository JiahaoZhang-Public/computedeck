import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The same vector is checked against the service in test_auth.py.
const VECTOR = 'f4e9265b9c298830b23757d96b55463df0b259499a9ece26785c3d0f44ccebfc';

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** A service on the page's origin; `proves` decides whether it holds the session token. */
function service(proves: (challenge: string) => string | undefined) {
  const sent: { path: string; token: string | null }[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    sent.push({ path, token: headers['X-ComputeDeck-Token'] ?? null });
    const challenge = new URL(path, 'http://127.0.0.1').searchParams.get('session_challenge');
    if (challenge) {
      return new Response(JSON.stringify({ status: 'ok', session_proof: proves(challenge) }));
    }
    return new Response('{}');
  });
  return sent;
}

let stored: ReturnType<typeof storage>;

beforeEach(() => {
  vi.resetModules();
  stored = storage({ 'computedeck.session': 'session-token' });
  vi.stubGlobal('window', { localStorage: stored });
});
afterEach(() => vi.unstubAllGlobals());

describe('stored session token', () => {
  it('computes the proof the service computes', async () => {
    const { sessionProof } = await import('./token');
    await expect(sessionProof('session-token', 'challenge-1')).resolves.toBe(VECTOR);
  });

  it('is sent only after the service proves it issued it', async () => {
    const sent = service((challenge) =>
      createHmac('sha256', 'session-token')
        .update(`computedeck-browser:${challenge}`)
        .digest('hex'),
    );
    const { api } = await import('./api');
    await Promise.all([api('/dashboard'), api('/health')]);
    // One check for requests made together, before either is sent.
    expect(sent.map((item) => item.path.split('?')[0])).toEqual([
      '/api/ping',
      '/api/dashboard',
      '/api/health',
    ]);
    expect(sent[0].token).toBeNull();
    expect(sent.slice(1).every((item) => item.token === 'session-token')).toBe(true);
  });

  it('is forgotten, never sent, when another program answers on the port', async () => {
    const sent = service(() => 'f'.repeat(64));
    const { api } = await import('./api');
    const { sessionRejected } = await import('./token');
    await api('/dashboard');
    expect(sent.every((item) => item.token === null)).toBe(true);
    expect(stored.values.has('computedeck.session')).toBe(false);
    expect(sessionRejected()).toBe(true);
  });

  it('is kept but not sent while the service cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const { api } = await import('./api');
    await expect(api('/dashboard')).rejects.toThrow('Failed to fetch');
    expect(stored.values.get('computedeck.session')).toBe('session-token');
  });

  it('a new sign-in clears the notice', async () => {
    service(() => undefined);
    const { api } = await import('./api');
    const { sessionRejected, setToken } = await import('./token');
    await api('/dashboard');
    expect(sessionRejected()).toBe(true);
    setToken('fresh-session');
    expect(sessionRejected()).toBe(false);
  });
});
