import { useState } from 'react';
import type { Unmeasured } from '../types';
import type { Ctx } from './shared';
import { formatMessage, t } from '../i18n';

export function UnmeasuredLinks({ items, ctx }: { items: Unmeasured[]; ctx: Ctx }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {(expanded ? items : items.slice(0, 2)).map(({ subject, reason }) => (
        <span className="sub" key={`${subject.kind}:${subject.id}:${reason.code}`}>
          <button
            className="link"
            onClick={(event) => {
              event.stopPropagation();
              if (subject.kind === 'instance') {
                const instance = ctx.data.instances.find((item) => item.id === subject.id);
                if (instance) ctx.openInstance(instance);
              } else {
                const source = ctx.data.sources.find((item) => item.id === subject.id);
                if (source) ctx.diagnose(source);
              }
            }}
          >
            {subject.name} — {formatMessage(reason)} ▸
          </button>
        </span>
      ))}
      {items.length > 2 && (
        <button
          className="link"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {expanded ? t('summary.fewer') : t('summary.more', { count: items.length - 2 })}
        </button>
      )}
    </>
  );
}
