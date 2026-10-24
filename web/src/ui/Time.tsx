import { useId, useState } from 'react';
import { absoluteTime, clockTime, duration, relativeTime } from '../format';
import { t } from '../i18n';
import { useClock } from './clock';
import { StatusShape } from './Status';
import './display.css';

/** Pass descriptionId to the enclosing row link's aria-describedby in tables. */
export function Time({
  value,
  relative = false,
  descriptionId,
}: {
  value: string | null;
  relative?: boolean;
  descriptionId?: string;
}) {
  const now = useClock();
  const disclosureId = useId();
  const [expanded, setExpanded] = useState(false);
  if (!value || !Number.isFinite(Date.parse(value))) return <span>{t('time.unknown')}</span>;
  return (
    <span className="display-time">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={disclosureId}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && expanded) {
            event.stopPropagation();
            setExpanded(false);
          }
        }}
      >
        <time dateTime={value}>
          {relative ? relativeTime(value, now) : clockTime(Date.parse(value))}
        </time>
      </button>
      <span className="time-disclosure" id={disclosureId} hidden={!expanded}>
        {absoluteTime(value)} · {relativeTime(value, now)}
      </span>
      {descriptionId && (
        <span className="sr-only" id={descriptionId}>
          {absoluteTime(value)} · {relativeTime(value, now)}
        </span>
      )}
    </span>
  );
}
export function Duration({ seconds, table = false }: { seconds: number; table?: boolean }) {
  return <span className="display-duration">{duration(seconds, table ? 'table' : 'prose')}</span>;
}
export function Age({
  label,
  value,
  stale = false,
}: {
  label?: string;
  value: string | null;
  stale?: boolean;
}) {
  const now = useClock();
  const seconds = value ? (now - Date.parse(value)) / 1000 : NaN;
  return (
    <span className="display-age">
      {label && <span>{label} </span>}
      {stale && (
        <>
          <StatusShape kind="unknown" /> {t('display.stale')} ·{' '}
        </>
      )}
      {Number.isFinite(seconds) ? <Duration seconds={Math.max(0, seconds)} /> : t('time.unknown')}
    </span>
  );
}
