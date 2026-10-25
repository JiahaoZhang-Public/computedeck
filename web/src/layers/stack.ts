import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

type Layer = {
  node: HTMLElement;
  modal: boolean;
  close: () => void;
  outside: boolean;
  anchor?: HTMLElement | null;
  inertBefore?: boolean;
  returnFocus?: boolean;
};
const stack: Layer[] = [];
let focusVersion = 0;
let pointerOpener: HTMLElement | null = null;
const listeners = new Set<() => void>();
let toastKeys: ((event: KeyboardEvent) => boolean) | undefined;
export function handleToastKeys(handler?: typeof toastKeys) {
  toastKeys = handler;
}
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const modalHost = () => [...stack].reverse().find((layer) => layer.modal)?.node ?? null;
function restoreInert(layer: Layer) {
  if (layer.inertBefore === undefined) return;
  layer.node.toggleAttribute('inert', layer.inertBefore);
  layer.inertBefore = undefined;
}
function syncModalInert() {
  const active = modalHost();
  for (const layer of stack) {
    if (!layer.modal) continue;
    if (layer.node === active) restoreInert(layer);
    else {
      // WebKit leaves lower native modals focusable. Preserve their own state
      // while explicitly excluding them from focus and the accessibility tree.
      layer.inertBefore ??= layer.node.hasAttribute('inert');
      layer.node.setAttribute('inert', '');
    }
  }
}
export function useModalHost() {
  return useSyncExternalStore(subscribe, modalHost, () => null);
}
export function hasModalLayer() {
  return modalHost() !== null;
}
export function fieldKey(event: KeyboardEvent) {
  return (
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.target instanceof Element &&
      !!event.target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}
function controls(node: HTMLElement) {
  return [
    ...node.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [tabindex]',
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length,
  );
}
function keydown(event: KeyboardEvent) {
  pointerOpener = null;
  if (event.defaultPrevented || event.isComposing) return;
  if (toastKeys?.(event)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const top = stack.at(-1);
  if (!top) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    top.close();
  } else if (event.key === 'Tab' && top.modal) {
    const items = controls(top.node);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      index < 0
        ? event.shiftKey
          ? items.length - 1
          : 0
        : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
    // Safari's default tab-to-text-fields setting must not decide modal containment.
    event.preventDefault();
    (items[next] ?? top.node).focus();
  }
}
function outsideControl(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const ancestor = target.closest<HTMLElement>(
    'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), label',
  );
  const control = ancestor instanceof HTMLLabelElement ? ancestor.control : ancestor;
  return control &&
    !control.matches(':disabled, input[type="hidden"]') &&
    !control.closest('[inert]')
    ? control
    : null;
}
function outside(event: PointerEvent) {
  if (event.target instanceof Element)
    pointerOpener = event.target.closest<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex], .clickable',
    );
  const top = stack.at(-1);
  if (
    !top?.outside ||
    !(event.target instanceof Node) ||
    (top.anchor !== document.body && top.anchor?.contains(event.target))
  )
    return;
  const box = top.node.getBoundingClientRect();
  if (
    !top.node.contains(event.target) ||
    (event.target === top.node &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom))
  ) {
    const control = event.target === top.node ? null : outsideControl(event.target);
    // Cancel only the dismissal's default focus change on blank content. That
    // suppresses its compatibility mousedown blur, but leaves click delivery and
    // subsequent pointer sequences alone. Real controls keep their normal focus.
    if (!control && event.button === 0) event.preventDefault();
    top.returnFocus = !control;
    top.close();
  }
}
let users = 0;
export function listenForLayers() {
  if (users++ === 0) {
    window.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', outside);
  }
  return () => {
    if (--users === 0) {
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', outside);
    }
  };
}

/** One stack owns Escape, focus return and the active modal's toast host. */
export function captureOpener() {
  const active = pointerOpener?.isConnected
    ? pointerOpener
    : (document.activeElement as HTMLElement | null);
  return active?.closest('[role="menu"]') ? (stack.at(-1)?.anchor ?? active) : active;
}

export function useLayer({
  modal,
  close,
  outside = false,
  anchor,
  initial,
  returnFocusId,
}: {
  modal: boolean;
  close: () => void;
  outside?: boolean;
  anchor?: HTMLElement | null;
  initial?: string;
  returnFocusId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const latest = useRef(close);
  const [opener] = useState(captureOpener);
  useLayoutEffect(() => {
    latest.current = close;
  });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previous = anchor ?? opener;
    const entry: Layer = { node, modal, close: () => latest.current(), outside, anchor };
    const unlisten = listenForLayers();
    const dialog = node instanceof HTMLDialogElement ? node : null;
    if (modal) dialog?.showModal();
    stack.push(entry);
    syncModalInert();
    focusVersion += 1;
    emit();
    const target = initial
      ? node.querySelector<HTMLElement>(initial)
      : node.querySelector<HTMLElement>('h2');
    if (target) {
      if (!target.matches('button, input, select, textarea, a[href]')) target.tabIndex = -1;
      target.focus();
    } else if (!node.contains(document.activeElement)) (controls(node)[0] ?? node).focus();
    const cancel = (event: Event) => {
      event.preventDefault();
      if (stack.at(-1) === entry)
        keydown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    };
    node.addEventListener('cancel', cancel);
    return () => {
      const wasTop = stack.at(-1) === entry;
      stack.splice(stack.indexOf(entry), 1);
      restoreInert(entry);
      syncModalInert();
      node.removeEventListener('cancel', cancel);
      dialog?.close();
      emit();
      unlisten();
      if (wasTop && entry.returnFocus !== false) {
        const version = focusVersion;
        const remaining = stack.at(-1);
        // React restores the pre-commit selection after layout cleanup. Return focus
        // after that restoration, unless a newer layer has already taken ownership.
        queueMicrotask(() => {
          if (focusVersion !== version || stack.at(-1) !== remaining) return;
          const target =
            previous instanceof HTMLElement &&
            previous.isConnected &&
            previous !== document.body &&
            previous !== document.documentElement
              ? previous
              : ((returnFocusId ? document.getElementById(returnFocusId) : null) ??
                document.querySelector<HTMLElement>('main h1, .topbar h1'));
          if (target) {
            if (!target.matches('button, input, select, textarea, a[href], [tabindex]'))
              target.tabIndex = -1;
            target.focus();
          }
        });
      }
    };
  }, [modal, outside, anchor, initial, returnFocusId, opener]);
  return ref;
}

export function useMedia(query: string) {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', notify);
      return () => media.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
