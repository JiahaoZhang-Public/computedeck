import { useSyncExternalStore } from 'react';

export const corePages = [
  'overview',
  'plan',
  'jobs',
  'activity',
  'resources',
  'cloud',
  'usage',
  'sources',
  'toolbox',
  'notify',
  'chat',
  'settings',
] as const;
export type CorePage = (typeof corePages)[number];
/** Core pages plus any page id contributed by a plugin. */
export type Page = string;
/** 'all' or a group key (cluster id or cloud platform key). */
export type Filter = string;

/** Shared by core links, plugin links and incoming bookmarks. */
export const routeAliases: Readonly<Record<string, string>> = Object.freeze({
  clusters: 'resources',
  nodes: 'resources?tab=nodes',
  marketplace: 'toolbox?tab=market',
});

/** Keep unknown pages and parameters intact while resolving the built-in aliases. */
export function canonicalHash(hash: string): string {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  const alias = Object.hasOwn(routeAliases, path) ? routeAliases[path] : undefined;
  const [page, defaults = ''] = (alias ?? path).split('?');
  const params = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(defaults)) params.set(key, value);
  const legacyNodes = page === 'resources' && params.has('nodes') && !params.has('tab');
  if (legacyNodes) params.set('tab', 'nodes');
  if (!alias && !legacyNodes) return hash;
  const query = params.toString();
  return `#/${page}${query ? `?${query}` : ''}`;
}

function subscribe(update: () => void) {
  const onChange = () => {
    const hash = canonicalHash(window.location.hash);
    if (hash !== window.location.hash) {
      // An alias must not add a Back stop or discard a detail entry's state.
      window.history.replaceState(window.history.state, '', hash);
    }
    update();
  };
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  onChange();
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** One snapshot for the page and its parameters, including changes during mount. */
export function useHash() {
  return useSyncExternalStore(
    subscribe,
    () => canonicalHash(window.location.hash),
    () => '',
  );
}

export function readRoute(
  knownPages: readonly string[],
  hash = window.location.hash,
): { page: Page; group: Filter } {
  const [path, search = ''] = canonicalHash(hash).replace(/^#\/?/, '').split('?');
  const page = knownPages.includes(path) ? path : 'overview';
  const params = new URLSearchParams(search);
  // `provider` is the parameter name used before groups were introduced.
  const group = params.get('group') ?? params.get('provider');
  return { page, group: group || 'all' };
}

export function routeHash(page: Page, group: Filter = 'all') {
  const hash = canonicalHash(`#/${page}`);
  if (group === 'all') return hash;
  return `${hash}${hash.includes('?') ? '&' : '?'}group=${encodeURIComponent(group)}`;
}
