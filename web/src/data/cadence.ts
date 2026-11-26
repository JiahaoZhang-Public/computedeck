import { useSyncExternalStore } from 'react';

const coarse = () => window.matchMedia?.('(pointer: coarse)');
function subscribe(listener: () => void) {
  const media = coarse();
  media?.addEventListener('change', listener);
  return () => media?.removeEventListener('change', listener);
}
function interval() {
  return coarse()?.matches ? 30000 : 10000;
}
export function usePollCadence() {
  return useSyncExternalStore(subscribe, interval);
}
