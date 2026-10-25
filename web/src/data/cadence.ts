import { useSyncExternalStore } from 'react';

const coarse = () => window.matchMedia?.('(pointer: coarse)');
function subscribe(listener: () => void) {
  const media = coarse();
  media?.addEventListener('change', listener);
  return () => media?.removeEventListener('change', listener);
}
function interval() {
  // The native app uses a mouse/trackpad even when a touch display is attached.
  const app =
    'webkit' in window && !!(window.webkit as { messageHandlers?: unknown }).messageHandlers;
  return !app && coarse()?.matches ? 30000 : 10000;
}
export function usePollCadence() {
  return useSyncExternalStore(subscribe, interval);
}
