import { canonicalHash } from '../routes';
import { routeParams, setRouteParams } from '../useRouteParam';

export const detailKeys = [
  'job',
  'failure',
  'instance',
  'array',
  'event',
  'attention',
  'node',
  'source',
] as const;
export function detailValues(values: Record<string, string | null> = {}) {
  return { ...Object.fromEntries(detailKeys.map((key) => [key, null])), ...values };
}
export function formKeys(params = routeParams()) {
  return ['add', 'edit', 'repair', 'step', ...(params.get('section') === 'ssh' ? ['section'] : [])];
}
// Only entries opened in this document are backed out of. Cold links close to their list.
const opened = new Set<string>();
export function openLayer(values: Record<string, string | null>, replace = false) {
  const before = window.location.hash;
  setRouteParams(values, !replace);
  if (!replace && before !== window.location.hash) {
    const state = { ...window.history.state, layerBase: before };
    window.history.replaceState(state, '', window.location.href);
    opened.add(state.layerBase);
  }
}
function normalizedHash(hash: string, without: string[] = []) {
  const params = routeParams(hash);
  for (const key of without) params.delete(key);
  const path = canonicalHash(hash).split('?')[0] || '#/overview';
  const query = params.toString();
  return path + (query ? `?${query}` : '');
}
export function closeLayer(keys: string[]) {
  const state = window.history.state;
  if (
    typeof state?.layerBase === 'string' &&
    opened.has(state.layerBase) &&
    normalizedHash(state.layerBase) === normalizedHash(window.location.hash, keys)
  )
    window.history.back();
  else setRouteParams(Object.fromEntries(keys.map((key) => [key, null])));
}
export function replaceLayer(values: Record<string, string | null>) {
  const state = window.history.state;
  setRouteParams(values);
  window.history.replaceState(state, '', window.location.href);
}

/** Step within the rendered list, including its current grouping, filters and order. */
export function stepVisibleDetail(direction: number) {
  const params = routeParams();
  const rows = [...document.querySelectorAll<HTMLElement>('main [data-detail-key]')].filter(
    (row) => !row.closest('.drawer') && row.getClientRects().length > 0,
  );
  const current = rows.find((row) => params.get(row.dataset.detailKey!) === row.dataset.detailId);
  if (!current) return;
  const container = current.closest('[data-detail-list]');
  if (!container) return;
  const list = rows.filter((row) => row.closest('[data-detail-list]') === container);
  const next = list[list.indexOf(current) + direction];
  if (next) {
    next.scrollIntoView({ block: 'nearest' });
    replaceLayer(
      detailValues({
        [next.dataset.detailKey!]: next.dataset.detailId!,
      }),
    );
  }
}
