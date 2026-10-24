import { useEffect, useRef } from 'react';

/** Poll immediately and on return to the page, pausing while the page is hidden. */
export function useVisibleInterval(
  callback: () => void | Promise<void>,
  ms: number,
  refreshKey?: string,
) {
  const lastReturn = useRef(-Infinity);
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void callback();
    };
    tick();
    const timer = window.setInterval(tick, ms);
    const returned = () => {
      if (document.hidden || Date.now() - lastReturn.current < 250) return;
      lastReturn.current = Date.now();
      tick();
    };
    document.addEventListener('visibilitychange', returned);
    window.addEventListener('focus', returned);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', returned);
      window.removeEventListener('focus', returned);
    };
  }, [callback, ms, refreshKey]);
}
