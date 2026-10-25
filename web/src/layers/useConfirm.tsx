import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

export function useConfirm() {
  const [request, setRequest] = useState<{ title: string; outcome: string } | null>(null);
  const resolve = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => resolve.current?.(false), []);
  function finish(value: boolean) {
    resolve.current?.(value);
    resolve.current = null;
    setRequest(null);
  }
  return [
    (title: string, outcome: string) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setRequest({ title, outcome });
      }),
    request ? (
      <ConfirmDialog {...request} close={() => finish(false)} confirm={() => finish(true)} />
    ) : null,
  ] as const;
}
