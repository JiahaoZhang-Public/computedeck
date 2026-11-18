import { formatMessage, t, type Message } from '../i18n';
import type { ReactNode } from 'react';
import { StatusLabel } from './Status';
import type { StatusKind } from './shapes';
import { Time } from './Time';
import './display.css';

export interface RuleTrace {
  rule: Message | string;
  included: string[];
  excluded: { source: string; reason: Message | string }[];
  as_of: string | null;
}
export function ScopeLine({
  scope,
  groups,
  asOf,
  estimate = false,
  descriptionId,
  timeLabel = t('display.asOf'),
  children,
}: {
  scope: string;
  groups?: string;
  asOf?: string | null;
  estimate?: boolean;
  descriptionId?: string;
  timeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <p className="scope-line">
      <strong>{scope}</strong>
      {groups && <> · {groups}</>}
      {asOf !== undefined && (
        <>
          {' '}
          · {timeLabel} <Time value={asOf} descriptionId={descriptionId} />
        </>
      )}
      {estimate && <> · {t('display.estimate')}</>}
      {children && <> · {children}</>}
    </p>
  );
}
export function HowWorkedOut({ trace }: { trace: RuleTrace }) {
  return (
    <details className="how-worked-out">
      <summary>{t('display.how')}</summary>
      <p>{formatMessage(trace.rule)}</p>
      <dl>
        <dt>{t('display.included')}</dt>
        <dd>{trace.included.join(', ') || t('display.none')}</dd>
        <dt>{t('display.excluded')}</dt>
        <dd>
          {trace.excluded.length ? (
            <ul>
              {trace.excluded.map(({ source, reason }) => (
                <li key={source}>
                  {source} · {formatMessage(reason)}
                </li>
              ))}
            </ul>
          ) : (
            t('display.none')
          )}
        </dd>
        <dt>{t('display.asOf')}</dt>
        <dd>
          <Time value={trace.as_of} />
        </dd>
      </dl>
    </details>
  );
}

export function CoverageLine({
  excluded,
}: {
  excluded: { name: string; kind: StatusKind; reason: string }[];
}) {
  if (!excluded.length) return null;
  return (
    <ul className="scope-line">
      {excluded.map(({ name, kind, reason }) => (
        <li key={name}>
          <StatusLabel kind={kind} label={name} reason={reason} />
        </li>
      ))}
    </ul>
  );
}
