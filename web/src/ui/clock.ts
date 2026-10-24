import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const minute = () => Math.floor(Date.now() / 60000) * 60000;
let timer: ReturnType<typeof setTimeout> | undefined;
let current = { now: minute(), format: '24' as '12' | '24' };
function notify() {
  for (const listener of listeners) listener();
}
/** Format changes also invalidate mounted labels, even within the same minute. */
export function setClockFormat(format: '12' | '24') {
  if (format === current.format) return;
  current = { ...current, format };
  notify();
}
function schedule() {
  timer = setTimeout(
    () => {
      const now = minute();
      if (now !== current.now) {
        current = { ...current, now };
        notify();
      }
      if (listeners.size) schedule();
    },
    60000 - (Date.now() % 60000),
  );
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    current = { ...current, now: minute() };
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
/** Only time labels subscribe; parents and rows do not tick. */
export function useClock() {
  return useSyncExternalStore(subscribe, () => current).now;
}
