import { ApiError } from './i18n';
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

export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const auth = await authHeaders();
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { headers: auth, credentials: 'omit' }
      : {
          method,
          credentials: 'omit',
          headers: { ...auth, 'Content-Type': 'application/json', 'X-ComputeDeck': '1' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw await failure(response);
  // 204 No Content (and other empty replies) carry no JSON body.
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Send a file as the raw request body. */
export async function upload<T>(path: string, file: Blob): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      ...(await authHeaders()),
      'Content-Type': 'application/octet-stream',
      'X-ComputeDeck': '1',
    },
    body: file,
  });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

/** A file the API serves, fetched with the access token, for saving. */
export async function download(path: string): Promise<Blob> {
  const response = await fetch(`/api${path}`, {
    headers: await authHeaders(),
    credentials: 'omit',
  });
  if (!response.ok) throw await failure(response);
  return response.blob();
}
