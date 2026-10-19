import { useState } from 'react';
import { ConnectionChecks } from './ConnectionChecks';
import { dateTime } from './domain';
import { formatMessage, t } from './i18n';
import type { Source } from './types';

/** Reading the diagnosis never runs a check; only the explicit button does. */
export function SourceDiagnosis({ source, demo }: { source: Source; demo: boolean }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="source-diagnosis">
      <header className="modal-header">
        <h2 id="modal-title">{t('attention.diagnosis', { name: source.name })}</h2>
        <p>{source.username || source.driver}</p>
      </header>
      <p>{t('attention.lastSuccess', { time: dateTime(source.last_success) })}</p>
      <p>{t('health.nextAttempt', { time: dateTime(source.next_due_at) })}</p>
      <p>{formatMessage(source.error) || t('attention.noError')}</p>
      {source.warnings?.map((warning, index) => (
        <p key={index}>{formatMessage(warning)}</p>
      ))}
      <button className="button" disabled={demo || checking} onClick={() => setChecking(true)}>
        {t('sources.testConnection')}
      </button>
      {demo && <p className="muted">{t('attention.exampleCheck')}</p>}
      {checking && <ConnectionChecks sourceId={source.id} />}
    </div>
  );
}
