import { Suspense, lazy } from 'react';
import type { ComponentProps } from 'react';
import type { MenuButton as Menu } from '../layers/Popover';

// Menus load with the first page that shows one, keeping the layer code out of the first paint.
const MenuButton = lazy(async () => ({ default: (await import('../layers/Popover')).MenuButton }));

/** A row's secondary actions. Until the menu code arrives, an inert copy of the trigger holds its place. */
export function LazyMenuButton(props: ComponentProps<typeof Menu>) {
  return (
    <Suspense
      fallback={
        <button
          type="button"
          className={props.className ?? 'button'}
          aria-label={props['aria-label'] ?? props.label}
          disabled
        >
          {props.children ?? props.label}
        </button>
      }
    >
      <MenuButton {...props} />
    </Suspense>
  );
}
