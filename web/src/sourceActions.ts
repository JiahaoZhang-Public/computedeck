import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Diagnostic } from './ConnectionChecks';
import type { Source } from './types';

// Shared across the diagnosis, saved-source check and command handlers.
let inFlight: Readonly<Record<string, 'test' | 'collect'>> = {};
const queuedCollections = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function useSourceInFlight() {
  return useSyncExternalStore(
    subscribe,
    () => inFlight,
    () => inFlight,
  );
}
function publish(id: string, kind?: 'test' | 'collect') {
  const next = { ...inFlight };
  if (kind) next[id] = kind;
  else delete next[id];
  inFlight = next;
  listeners.forEach((listener) => listener());
}
export async function testSource(
  id: string,
  options?: { signal: AbortSignal; onRows: (rows: Diagnostic[]) => void },
) {
  if (inFlight[id]) return;
  publish(id, 'test');
  try {
    return await api<Diagnostic[]>(`/sources/${encodeURIComponent(id)}/check`, {}, 'POST', options);
  } finally {
    publish(id);
  }
}
export async function collectSource(source: Source) {
  if (inFlight[source.id]) return false;
  publish(source.id, 'collect');
  try {
    await api('/refresh', { source_id: source.id });
    queuedCollections.add(source.id);
    return true;
  } catch (error) {
    publish(source.id);
    throw error;
  }
}
/** Called only for accepted polls after the Collect request. */
export function finishCollections(collecting: string[]) {
  for (const [id, kind] of Object.entries(inFlight)) {
    if (kind === 'collect' && queuedCollections.has(id) && !collecting.includes(id)) {
      queuedCollections.delete(id);
      publish(id);
    }
  }
}
/** A schedule setting is independent of a read-only check; Undo must remain available. */
export async function setSourcePaused(source: Source, paused: boolean) {
  await api(`/sources/${encodeURIComponent(source.id)}`, { enabled: !paused }, 'PUT');
}
