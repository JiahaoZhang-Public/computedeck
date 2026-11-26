import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Unmeasured } from '../types';
import type { Ctx } from './shared';
import { formatMessage } from '../i18n';
import { Popover } from '../layers/Popover';
import { keepActivation } from './util';

/** The detail behind an unmeasured marker: each subject and its reason, one link each. */
export default function UnmeasuredPopover({
  anchor,
  labelledBy,
  close,
  items,
  ctx,
  note,
  title,
}: {
  /** What the list is, in words: "3 not counted". */
  title?: string;
  anchor: HTMLElement;
  labelledBy: string;
  close: () => void;
  items: Unmeasured[];
  ctx: Ctx;
  note?: ReactNode;
}) {
  function open({ subject }: Unmeasured) {
    // Close first and refocus the marker, so the detail opened next returns focus there.
    flushSync(close);
    anchor.focus();
    if (subject.kind === 'instance') {
      const instance = ctx.data.instances.find((item) => item.id === subject.id);
      if (instance) ctx.openInstance(instance);
    } else {
      const source = ctx.data.sources.find((item) => item.id === subject.id);
      if (source) ctx.diagnose(source);
    }
  }
  return (
    <Popover anchor={anchor} close={close} labelledBy={labelledBy}>
      <div
        className="unmeasured-list"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepActivation}
      >
        {title && <div className="unmeasured-title">{title}</div>}
        {!!items.length && (
          <ul>
            {items.map((item) => (
              <li key={`${item.subject.kind}:${item.subject.id}:${item.reason.code}`}>
                <button type="button" className="link" onClick={() => open(item)}>
                  <strong>{item.subject.name}</strong>
                  {formatMessage(item.reason)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {note && <p>{note}</p>}
      </div>
    </Popover>
  );
}
