import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { api } from './api';
import { errorText, localized, t } from './i18n';
import type { Localized } from './types';

export interface Diagnostic {
  id: string;
  state: 'ok' | 'failed' | 'missing';
  label: Localized;
  detail: Localized;
}

export function DiagnosticRows({ rows }: { rows: Diagnostic[] }) {
  return (
    <ul className="checklist">
      {rows.map((row) => (
        <li key={row.id} className={row.state}>
          {row.state === 'ok' ? (
            <CheckCircle2 size={16} />
          ) : row.state === 'failed' ? (
            <XCircle size={16} />
          ) : (
            <MinusCircle size={16} />
          )}
          <span>
            <strong>{localized(row.label)}</strong>
            {Object.keys(row.detail).length > 0 && <small>{localized(row.detail)}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ConnectionChecks({ sourceId }: { sourceId: string }) {
  const [rows, setRows] = useState<Diagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    void api<Diagnostic[]>(`/sources/${encodeURIComponent(sourceId)}/check`, {})
      .then((result) => {
        if (!closed) setRows(result);
      })
      .catch((reason) => {
        if (!closed) setError(errorText(reason, 'error.service'));
      });
    return () => {
      closed = true;
    };
  }, [sourceId]);
  if (error)
    return (
      <p className="red-text" role="alert">
        {error}
      </p>
    );
  if (rows) return <DiagnosticRows rows={rows} />;
  return (
    <p>
      <Loader2 size={16} className="spin" /> {t('sources.checking')}
    </p>
  );
}
