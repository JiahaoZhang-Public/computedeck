import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Time } from './Time';
import { StatusLabel } from './Status';
import './display.css';

type State =
  | { state: 'loading'; rows?: number; rowHeight?: number }
  | { state: 'first'; title?: string; text?: string; action?: ReactNode; example?: ReactNode }
  | { state: 'quiet'; title?: string; text?: string; action?: ReactNode }
  | { state: 'filtered'; hidden: number; onClear: () => void }
  | { state: 'error' | 'stale'; reason: string; at: string | null; children?: ReactNode };

export function DataState(props: State) {
  return (
    <section className="data-state" data-state={props.state} aria-busy={props.state === 'loading'}>
      {props.state === 'loading' ? (
        <>
          <p role="status">{t('common.loading')}</p>
          <div aria-hidden="true">
            {Array.from({ length: props.rows ?? 3 }, (_, index) => (
              <div
                className="data-skeleton"
                key={index}
                style={{ height: props.rowHeight ?? 40 }}
              />
            ))}
          </div>
        </>
      ) : props.state === 'first' ? (
        <>
          {props.title && <h2>{props.title}</h2>}
          <p>{props.text ?? t('display.first')}</p>
          {props.action}
          {props.action && props.example ? ' ' : null}
          {props.example}
        </>
      ) : props.state === 'quiet' ? (
        <>
          {props.title && <h2>{props.title}</h2>}
          <p>{props.text ?? t('display.quiet')}</p>
          {props.action}
        </>
      ) : props.state === 'filtered' ? (
        <p>
          {t('display.hidden', { count: props.hidden })} ·{' '}
          <button type="button" className="link" onClick={props.onClear}>
            {t('display.clear')}
          </button>
        </p>
      ) : (
        <>
          <StatusLabel
            kind={props.state === 'error' ? 'error' : 'unknown'}
            label={t(`display.${props.state}`)}
            reason={props.reason}
          />
          <p>
            {t('display.lastData')} · <Time value={props.at} />
          </p>
          {props.children}
        </>
      )}
    </section>
  );
}
