import { useLayoutEffect, useRef, useState, useId } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLayer, useMedia, modalHost } from './stack';
import { Sheet } from './Surface';

export function Popover({
  anchor,
  close,
  labelledBy,
  children,
  menu = false,
  fromEnd = false,
}: {
  anchor: HTMLElement;
  close: () => void;
  labelledBy: string;
  children: ReactNode;
  menu?: boolean;
  fromEnd?: boolean;
}) {
  const touch = useMedia('(pointer: coarse)');
  if (touch)
    return (
      <Sheet
        labelledBy={labelledBy}
        close={close}
        opener={anchor}
        className="touch-popover"
        initial={
          menu ? (fromEnd ? '[role^="menuitem"]:last-child' : '[role^="menuitem"]') : undefined
        }
      >
        {children}
      </Sheet>
    );
  return (
    <Floating anchor={anchor} close={close} labelledBy={labelledBy} menu={menu} fromEnd={fromEnd}>
      {children}
    </Floating>
  );
}
function Floating({
  anchor,
  close,
  labelledBy,
  children,
  menu,
  fromEnd,
}: {
  anchor: HTMLElement;
  close: () => void;
  labelledBy: string;
  children: ReactNode;
  menu: boolean;
  fromEnd: boolean;
}) {
  const ref = useLayer({
    modal: false,
    close,
    outside: true,
    anchor,
    initial: menu ? (fromEnd ? '[role^="menuitem"]:last-child' : '[role^="menuitem"]') : undefined,
  });
  useLayoutEffect(() => {
    const node = ref.current!;
    function place() {
      const rect = anchor.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
      const below = rect.bottom + 4;
      const above = rect.top - box.height - 4;
      const top = below + box.height <= innerHeight - 8 ? below : above;
      node.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`;
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, ref]);
  const content = (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      className="layer-popover"
      role={menu ? undefined : 'dialog'}
      aria-labelledby={menu ? undefined : labelledBy}
      tabIndex={-1}
    >
      {children}
    </div>
  );
  const host = modalHost();
  return host ? createPortal(content, host) : content;
}
export function MenuButton({
  label,
  'aria-label': ariaLabel,
  children,
  className = 'button',
  disabled,
  describedBy,
  items,
}: {
  label?: string;
  'aria-label'?: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  describedBy?: string;
  items: {
    id: string;
    label: string;
    action: () => void;
    disabled?: boolean;
    checked?: boolean;
    role?: 'menuitemradio' | 'menuitemcheckbox';
  }[];
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = !!anchor;
  const close = () => setAnchor(null);
  const id = useId();
  const menuId = useId();
  const touch = useMedia('(pointer: coarse)');
  const [fromEnd, setFromEnd] = useState(false);
  const search = useRef({ text: '', at: 0 });
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
        disabled={disabled}
        id={id}
        aria-haspopup={touch ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          setFromEnd(false);
          setAnchor(open ? null : event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setFromEnd(event.key === 'ArrowUp');
            setAnchor(event.currentTarget);
          }
        }}
      >
        {children ?? label}
      </button>
      {anchor && (
        <Popover anchor={anchor} close={close} labelledBy={id} menu fromEnd={fromEnd}>
          <div
            id={menuId}
            role="menu"
            aria-labelledby={id}
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              let next: number;
              if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
              else if (event.key === 'ArrowUp')
                next = (index - 1 + buttons.length) % buttons.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = buttons.length - 1;
              else if (event.key === 'Tab') {
                close();
                return;
              } else if (
                event.key.length === 1 &&
                event.key !== ' ' &&
                !event.nativeEvent.isComposing &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                search.current.text =
                  (Date.now() - search.current.at < 700 ? search.current.text : '') +
                  event.key.toLocaleLowerCase();
                search.current.at = Date.now();
                const match = buttons.findIndex(
                  (button, i) =>
                    i > index &&
                    button.textContent?.toLocaleLowerCase().startsWith(search.current.text),
                );
                next =
                  match >= 0
                    ? match
                    : buttons.findIndex((button) =>
                        button.textContent?.toLocaleLowerCase().startsWith(search.current.text),
                      );
              } else return;
              event.preventDefault();
              event.stopPropagation();
              buttons[next]?.focus();
            }}
          >
            {items.map((item) => (
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : (item.role ?? 'menuitemradio')}
                aria-checked={item.checked}
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                key={item.id}
                onClick={() => {
                  if (!item.disabled) {
                    close();
                    item.action();
                  }
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
