import { money, number } from '../format';
import { t } from '../i18n';
import { Time } from './Time';
import './display.css';

type Figure =
  | { value: null; reason: string; kind?: never; at?: never }
  | { value: number; kind?: 'exact' | 'lower' | 'estimate'; reason?: string; at?: never }
  | { value: number; kind: 'lastKnown'; at: string; reason: string };

/** Stale exact values are unknown; only an explicit lower bound or last-known value survives. */
export function Value({
  value,
  kind,
  reason,
  at,
  unit,
  currency,
  stale = false,
}: Figure & {
  unit?: string;
  currency?: string;
  stale?: boolean;
}) {
  const unknown =
    value == null || !Number.isFinite(value) || (stale && kind !== 'lower' && kind !== 'lastKnown');
  return (
    <span className={`display-value${unknown ? ' value-unknown' : ''}`}>
      {unknown ? (
        '—'
      ) : (
        <>
          {kind === 'lower'
            ? '≥ '
            : kind === 'estimate'
              ? '≈ '
              : kind === 'lastKnown'
                ? `${t('display.lastKnown')} `
                : ''}
          {currency ? money(value, currency, kind === 'lower') : number(value)}
          {unit && <span className="value-unit"> {unit}</span>}
          {kind === 'estimate' && <span className="value-unit"> · {t('display.estimate')}</span>}
          {kind === 'lastKnown' && (
            <>
              {' '}
              · <Time value={at} />
            </>
          )}
        </>
      )}
      {(reason || unknown) && (
        <span className="value-unit">
          {' '}
          · {reason || t(stale ? 'display.stale' : 'time.unknown')}
        </span>
      )}
    </span>
  );
}
