import { Suspense, lazy, useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { Unmeasured } from '../types';
import type { Ctx } from './shared';
import { t } from '../i18n';
import { StatusShape } from '../ui/Status';
import { keepActivation } from './util';

// The list only loads when opened, so the trigger costs almost nothing on first paint.
const UnmeasuredPopover = lazy(() => import('./UnmeasuredPopover'));

/**
 * A partial number that opens what it does not count. The number itself is the trigger
 * ("≥ 27", dotted underline); without a number, a small "unknown" mark is. Each listed
 * source or machine still opens its diagnosis or instance.
 */
export function UnmeasuredLinks({
  items,
  ctx,
  value,
  label,
  note,
}: {
  items: Unmeasured[];
  ctx: Ctx;
  /** The partial figure shown as the trigger; without it, an icon-only trigger. */
  value?: string | number;
  /** What is not counted, for the accessible name; defaults to "{count} not counted". */
  label?: string;
  /** One more line inside the list, such as machines with monitoring off. */
  note?: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const id = useId();
  if (!items.length && !note) return value ?? null;
  const what = label ?? t('unmeasured.count', { count: items.length });
  return (
    <>
      <button
        type="button"
        id={id}
        className={value === undefined ? 'icon-button unmeasured-mark' : 'partial'}
        aria-label={value === undefined ? what : `${value}, ${what}`}
        title={what}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(anchor ? null : event.currentTarget);
        }}
        onKeyDown={keepActivation}
      >
        {value ?? <StatusShape kind="unknown" />}
      </button>
      {anchor && (
        <Suspense fallback={null}>
          <UnmeasuredPopover
            anchor={anchor}
            labelledBy={id}
            close={() => setAnchor(null)}
            items={items}
            ctx={ctx}
            note={note}
          />
        </Suspense>
      )}
    </>
  );
}
