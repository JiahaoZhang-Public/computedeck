import { useEffect, useMemo, useRef } from 'react';

/** Keep keyboard navigation inside an open drawer or confirmation, then return to its trigger. */
export function useDialogFocus(returnFocusId?: string, active = true) {
  const ref = useRef<HTMLElement>(null);
  // Capture the opener before a child input's autoFocus runs during mounting.
  const previous = useMemo(
    () => (active && typeof document !== 'undefined' ? document.activeElement : null),
    [active],
  );
  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const controls = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length,
      );
    if (!dialog.contains(document.activeElement)) (controls()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      const elements = controls();
      const first = elements[0] ?? dialog;
      const last = elements.at(-1) ?? dialog;
      if (
        !dialog.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else if (returnFocusId) document.getElementById(returnFocusId)?.focus();
    };
  }, [returnFocusId, active, previous]);
  return ref;
}
