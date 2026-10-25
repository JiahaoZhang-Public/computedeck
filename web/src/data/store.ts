import type { CollectionNode, Dashboard, Health, Tool } from '../types';

function rowKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  const id = row.id ?? row.key ?? row.at;
  if (id !== undefined) return JSON.stringify([row.source_id ?? '', id]);
}

/** Revisions short-circuit rows; other JSON values share their unchanged branches. */
export function share<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const keyed = new Map(previous.map((row) => [rowKey(row), row]));
    const rows = next.map((row, index) => {
      const key = rowKey(row);
      return share(key === undefined ? previous[index] : keyed.get(key), row);
    });
    return (
      rows.length === previous.length && rows.every((row, i) => row === previous[i])
        ? previous
        : rows
    ) as T;
  }
  if (Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  if (after.rev && before.rev === after.rev && rowKey(before) === rowKey(after)) return previous;
  const result = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [key, share(before[key], value)]),
  );
  return (
    Object.keys(before).length === Object.keys(after).length &&
    Object.keys(after).every((key) => Object.is(before[key], result[key]))
      ? previous
      : result
  ) as T;
}

export type LiveSnapshot = {
  data: Dashboard | null;
  health: Health | null;
  tools: Tool[];
  nodes: CollectionNode[];
  error: string | null;
  needsToken: boolean;
  loading: boolean;
  announcement: { id: number; text: string };
};

/** One accepted poll publishes once; an unchanged poll never notifies React. */
export function createLiveStore() {
  let current: LiveSnapshot = {
    data: null,
    health: null,
    tools: [],
    nodes: [],
    error: null,
    needsToken: false,
    loading: true,
    announcement: { id: 0, text: '' },
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch: Partial<LiveSnapshot>) => {
      const next = share(current, { ...current, ...patch });
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
