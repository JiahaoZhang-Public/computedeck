import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { StatusShape } from '../ui/Status';
import { handleToastKeys, listenForLayers, useModalHost } from './stack';

export type ToastAction = { label: string; run: () => void; undo?: boolean };
export type Toast = { id: number; text: string; tone: 'ok' | 'error'; action?: ToastAction };
export function Toasts({ items, dismiss }: { items: Toast[]; dismiss: (id?: number) => void }) {
  const host = useModalHost();
  const region = useRef<HTMLDivElement>(null);
  const home = useRef<HTMLDivElement>(null);
  const [portal] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    (host ?? home.current!).append(portal);
    return () => portal.remove();
  }, [host, portal]);
  useEffect(() => {
    const node = region.current;
    if (!node) return;
    const place = () => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || node.contains(focused)) return;
      node.style.top = '';
      node.style.bottom = '';
      if (
        focused === host ||
        focused.matches('html, body, dialog, aside') ||
        !focused.matches(
          'button, input, select, textarea, a[href], [contenteditable="true"], [tabindex]',
        ) ||
        (focused.tabIndex < 0 &&
          !focused.matches('button, input, select, textarea, a[href], [contenteditable="true"]'))
      )
        return;
      const a = focused.getBoundingClientRect();
      const b = node.getBoundingClientRect();
      if (a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right) {
        node.style.bottom = 'auto';
        node.style.top = '12px';
      }
    };
    place();
    document.addEventListener('focusin', place);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('focusin', place);
      window.removeEventListener('resize', place);
    };
  }, [host, items]);
  useEffect(() => {
    const unlisten = listenForLayers();
    handleToastKeys((event) => {
      if (event.key === 'Escape' && items.length) {
        dismiss();
        return true;
      }
      const undo = [...items].reverse().find((item) => item.action?.undo);
      if (
        undo &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'z' &&
        !event.shiftKey &&
        !(
          event.target instanceof Element &&
          event.target.closest('input, textarea, [contenteditable="true"]')
        )
      ) {
        undo.action!.run();
        dismiss(undo.id);
        return true;
      }
      return false;
    });
    return () => {
      handleToastKeys();
      unlisten();
    };
  }, [items, dismiss]);
  const content = (
    <div
      ref={region}
      className="toasts"
      role="status"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => (
        <ToastItem key={item.id} item={item} dismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
  return (
    <>
      <div ref={home} />
      {createPortal(content, portal)}
    </>
  );
}
function ToastItem({ item, dismiss }: { item: Toast; dismiss: () => void }) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.action?.undo ? 10000 : 4500);
  useEffect(() => {
    if (item.tone === 'error' || hover || focused) return;
    const start = Date.now();
    const timer = window.setTimeout(dismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - start;
    };
  }, [item.tone, hover, focused, dismiss]);
  return (
    <div
      className={`toast ${item.tone}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <StatusShape kind={item.tone === 'error' ? 'error' : 'ok'} />
      <span>
        {item.tone === 'error' && <span className="sr-only">{t('display.errorPrefix')} </span>}
        {item.text}
      </span>
      {item.action && (
        <button
          className="button"
          type="button"
          onClick={() => {
            item.action!.run();
            dismiss();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        className="icon-button"
        type="button"
        aria-label={t('common.dismiss')}
        onClick={dismiss}
      >
        <X size={14} />
      </button>
    </div>
  );
}
