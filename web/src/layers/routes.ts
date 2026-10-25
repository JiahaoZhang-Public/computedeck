import { canonicalHash } from '../routes';
import { routeParams, setRouteParams } from '../useRouteParam';

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
export function closeLayer(keys: string[]) {
  const state = window.history.state;
  const params = routeParams();
  for (const key of keys) params.delete(key);
  const path = canonicalHash(window.location.hash).split('?')[0];
  const base = path + (params.size ? `?${params}` : '');
  if (state?.layerBase === base && opened.has(state.layerBase)) window.history.back();
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
  const list = rows.filter((row) => row.closest('table') === current.closest('table'));
  const next = list[list.indexOf(current) + direction];
  if (next)
    replaceLayer({
      job: null,
      failure: null,
      array: null,
      instance: null,
      event: null,
      [next.dataset.detailKey!]: next.dataset.detailId!,
    });
}
