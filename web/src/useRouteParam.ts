import { canonicalHash, useHash } from './routes';

export function routeParams(hash = window.location.hash) {
  return new URLSearchParams(canonicalHash(hash).split('?')[1] ?? '');
}

/** Update only view state; the connection and example-mode query stays untouched. */
export function setRouteParams(values: Record<string, string | null>, push = false) {
  const before = window.location.href;
  const url = new URL(before);
  const params = routeParams(url.hash);
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(name, value);
    else params.delete(name);
  }
  const path = canonicalHash(url.hash).split('?')[0] || '#/overview';
  url.hash = canonicalHash(path + (params.size ? `?${params}` : ''));
  if (url.href === before) return;
  if (push) window.history.pushState({ detail: true }, '', url);
  else window.history.replaceState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: before, newURL: url.href }));
}

export function useRouteParam(name: string, fallback = '') {
  const hash = useHash();
  const value = routeParams(hash).get(name) ?? fallback;
  return [
    value,
    (next: string) => setRouteParams({ [name]: next === fallback ? null : next }),
  ] as const;
}
