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

export function readRoute(
  knownPages: readonly string[],
  hash = window.location.hash,
): { page: Page; group: Filter } {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  const page = knownPages.includes(path) ? path : 'overview';
  const params = new URLSearchParams(search);
  // `provider` is the parameter name used before groups were introduced.
  const group = params.get('group') ?? params.get('provider');
  return { page, group: group || 'all' };
}

export function routeHash(page: Page, group: Filter = 'all') {
  return group === 'all' ? `#/${page}` : `#/${page}?group=${encodeURIComponent(group)}`;
}
