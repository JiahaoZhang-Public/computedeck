import { useEffect, useRef } from 'react';

/** Keep keyboard navigation inside an open drawer or confirmation, then return to its trigger. */
export function useDialogFocus(returnFocusId?: string) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    const controls = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]',
        ),
      ].filter(
        (element) =>
          element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length,
      );
    (controls()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
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
  }, [returnFocusId]);
  return ref;
}
