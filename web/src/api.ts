import { ApiError, t } from './i18n';
import type { Message } from './i18n';
import { verifiedToken } from './token';

export type Request = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

async function authHeaders(): Promise<Record<string, string>> {
  const secret = await verifiedToken();
  // A header, not a cookie: cookies for 127.0.0.1 would also reach other local ports.
  return secret ? { 'X-ComputeDeck-Token': secret } : {};
}

async function failure(response: Response): Promise<ApiError> {
  let detail: Message | string | null = null;
  try {
    const error = await response.json();
    const value = error.detail ?? error;
    detail =
      typeof value === 'string' || (value && typeof value.code === 'string')
        ? value
        : JSON.stringify(value);
  } catch {
    /* Response may not contain JSON. */
  }
  return new ApiError(response.status, detail);
}

function checkExampleMode(path: string, method: string) {
  // The access-token check only authenticates the viewer; it does not change resources.
  if (path === '/session' && method === 'POST') return;
  if (method !== 'GET' && new URLSearchParams(window.location.search).get('demo') === 'true')
    throw new Error(t('toast.demoReadOnly'));
}

/** All host API traffic, including plugin requests and file uploads, goes through here. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  checkExampleMode(path, method);
  const auth = await authHeaders();
  // The user may have switched modes while the session was being verified.
  checkExampleMode(path, method);
  const response = await fetch(`/api${path}`, {
    ...init,
    method,
    headers: {
      ...auth,
      ...(method !== 'GET' ? { 'X-ComputeDeck': '1' } : {}),
      ...init.headers,
    },
    credentials: 'omit',
  });
  if (!response.ok) throw await failure(response);
  return response;
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  // 204 No Content (and other empty replies) carry no JSON body.
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Send a file as the raw request body. */
export async function upload<T>(path: string, file: Blob): Promise<T> {
  const response = await request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: file,
  });
  return response.json() as Promise<T>;
}

/** A file the API serves, fetched with the access token, for saving. */
export async function download(path: string): Promise<Blob> {
  return (await request(path)).blob();
}
