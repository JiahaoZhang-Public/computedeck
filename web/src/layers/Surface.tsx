import { useLayoutEffect, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { useLayer, useMedia, fieldKey, captureOpener } from './stack';

type Props = {
  children: ReactNode;
  labelledBy: string;
  close: () => void;
  className?: string;
  initial?: string;
  returnFocusId?: string;
  opener?: HTMLElement | null;
};
export function Sheet({
  children,
  labelledBy,
  close,
  className = '',
  initial,
  returnFocusId,
  opener,
  dismissOutside = true,
}: Props & { dismissOutside?: boolean }) {
  const ref = useLayer({
    modal: true,
    close,
    outside: dismissOutside,
    initial,
    returnFocusId,
    anchor: opener,
  });
  useLayoutEffect(() => {
    const node = ref.current!;
    // Lazy forms and translated, wrapping action bars can change height after opening.
    const measure = () => {
      const bars = [...node.querySelectorAll<HTMLElement>('.modal-footer, .drawer-actions')].filter(
        (bar) => bar.closest('dialog') === node,
      );
      const height = Math.max(0, ...bars.map((bar) => bar.getBoundingClientRect().height));
      node.style.scrollPaddingBottom = `${height + 8}px`;
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(node);
      node.querySelectorAll('.modal-footer, .drawer-actions').forEach((bar) => resize.observe(bar));
      measure();
    };
    const content = new MutationObserver(observe);
    content.observe(node, { childList: true, subtree: true });
    observe();
    return () => {
      content.disconnect();
      resize.disconnect();
    };
  }, [ref]);
  return (
    <dialog
      ref={ref as Ref<HTMLDialogElement>}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      className={`layer-sheet ${className}`}
    >
      {children}
    </dialog>
  );
}
export function FocusView(props: Props) {
  return (
    <Sheet
      {...props}
      className={`modal focus-view ${props.className ?? ''}`}
      dismissOutside={false}
    />
  );
}
export function ContextPanel({
  onStep,
  ...props
}: Props & { onStep?: (direction: number) => void }) {
  const wide = useMedia('(min-width: 1200px)');
  const [opener] = useState(captureOpener);
  return wide ? (
    <Beside {...props} opener={opener} onStep={onStep} />
  ) : (
    <Sheet {...props} opener={opener} className={`drawer ${props.className ?? ''}`} />
  );
}
function Beside({
  children,
  labelledBy,
  close,
  className = '',
  returnFocusId,
  opener,
  onStep,
}: Props & { onStep?: (direction: number) => void }) {
  const ref = useLayer({ modal: false, close, returnFocusId, anchor: opener });
  return (
    <aside
      className={`drawer context-panel ${className}`}
      ref={ref}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          !onStep ||
          fieldKey(event.nativeEvent) ||
          event.shiftKey ||
          !['j', 'k'].includes(event.key)
        )
          return;
        event.preventDefault();
        onStep(event.key === 'j' ? 1 : -1);
      }}
    >
      {children}
    </aside>
  );
}
