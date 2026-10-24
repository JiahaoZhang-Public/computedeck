import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Time } from './Time';
import { Status } from './Status';
import './display.css';

type State =
  | { state: 'loading'; rows?: number; rowHeight?: number }
  | { state: 'first'; action: ReactNode; example: ReactNode }
  | { state: 'quiet' }
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
          <p>{t('display.first')}</p>
          {props.action} {props.example}
        </>
      ) : props.state === 'quiet' ? (
        <p>{t('display.quiet')}</p>
      ) : props.state === 'filtered' ? (
        <p>
          {t('display.hidden', { count: props.hidden })} ·{' '}
          <button type="button" className="link" onClick={props.onClear}>
            {t('display.clear')}
          </button>
        </p>
      ) : (
        <>
          <Status
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
