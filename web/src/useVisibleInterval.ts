import { useEffect } from 'react';

/** Poll immediately and on return to the page, pausing while the page is hidden. */
export function useVisibleInterval(
  callback: () => void | Promise<void>,
  ms: number,
  refreshKey?: string,
) {
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void callback();
    };
    tick();
    const timer = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [callback, ms, refreshKey]);
}
