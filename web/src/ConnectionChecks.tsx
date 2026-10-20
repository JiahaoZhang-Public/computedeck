import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { api } from './api';
import { errorText, localized, t } from './i18n';
import type { Localized } from './types';

export interface Diagnostic {
  id: string;
  state: 'ok' | 'failed' | 'missing' | 'checking';
  command?: string;
  label: Localized;
  detail: Localized;
}

export function DiagnosticRows({ rows }: { rows: Diagnostic[] }) {
  return (
    <ol className="checklist" aria-label={t('sources.checkSteps')}>
      {rows.map((row) => (
        <li key={row.id} className={row.state}>
          {row.state === 'checking' ? (
            <Loader2 size={16} className="spin" />
          ) : row.state === 'ok' ? (
            <CheckCircle2 size={16} />
          ) : row.state === 'failed' ? (
            <XCircle size={16} />
          ) : (
            <MinusCircle size={16} />
          )}
          <span>
            <strong>
              {localized(row.label)}{' '}
              <small className="check-state">{t(`sources.checkState.${row.state}`)}</small>
            </strong>
            {Object.keys(row.detail).length > 0 && <small>{localized(row.detail)}</small>}
            {row.command && <code className="diagnostic-command">{row.command}</code>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ConnectionChecks({ sourceId }: { sourceId: string }) {
  const [rows, setRows] = useState<Diagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    const controller = new AbortController();
    void api<Diagnostic[]>(`/sources/${encodeURIComponent(sourceId)}/check`, {}, 'POST', {
      signal: controller.signal,
      onRows: (next) => {
        if (!closed) setRows(next);
      },
    })
      .then((result) => {
        if (!closed) setRows(result);
      })
      .catch((reason) => {
        if (!closed) setError(errorText(reason, 'error.service'));
      });
    return () => {
      closed = true;
      controller.abort();
    };
  }, [sourceId]);
  return (
    <>
      {rows && <DiagnosticRows rows={rows} />}
      {error ? (
        <p className="red-text" role="alert">
          {error}
        </p>
      ) : (
        !rows && (
          <p>
            <Loader2 size={16} className="spin" /> {t('sources.checking')}
          </p>
        )
      )}
    </>
  );
}
