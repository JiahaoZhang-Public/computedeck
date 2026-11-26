import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

/** Stable event handlers for memoized rows; calls see the latest committed data. */
export function useStableActions<T extends { [K in keyof T]: (...args: never[]) => unknown }>(
  actions: T,
): T {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const call = useCallback((key: keyof T, args: never[]) => latest.current[key](...args), []);
  const keys = Object.keys(actions).join(',');
  return useMemo(
    () =>
      Object.fromEntries(
        keys.split(',').map((key) => [key, (...args: never[]) => call(key as keyof T, args)]),
      ) as T,
    [keys, call],
  );
}
