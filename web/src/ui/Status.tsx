import type { ReactNode } from 'react';
import { t } from '../i18n';
import { shapes, type StatusKind } from './shapes';
import './display.css';

export function StatusShape({
  kind,
  size = 12,
  label,
}: {
  kind: StatusKind;
  size?: number;
  label?: string;
}) {
  return (
    <svg
      className={`status-shape severity-${kind}`}
      style={{
        width: Math.max(size, kind === 'unknown' ? 12 : 10),
        height: Math.max(size, kind === 'unknown' ? 12 : 10),
      }}
      viewBox="0 0 12 12"
      role={label ? 'img' : undefined}
      aria-label={
        label
          ? `${kind === 'error' || kind === 'warn' ? `${t(`display.${kind}Prefix`)} ` : ''}${label}`
          : undefined
      }
      aria-hidden={label ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: shapes[kind] }}
    />
  );
}

/** Core display component. ui.tsx retains the frozen plugin Status DOM. */
export function Status({
  kind,
  label,
  reason,
  age,
}: {
  kind: StatusKind;
  label?: string;
  reason?: ReactNode;
  age?: ReactNode;
}) {
  return (
    <span className={`display-status severity-${kind}`}>
      <StatusShape kind={kind} />
      <span className="status-word">
        {(kind === 'error' || kind === 'warn') && (
          <span className="sr-only">{t(`display.${kind}Prefix`)} </span>
        )}
        {label ?? t(`display.status.${kind}`)}
      </span>
      {reason && <span> · {reason}</span>}
      {age && <span> · {age}</span>}
    </span>
  );
}
