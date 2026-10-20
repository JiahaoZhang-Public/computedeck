import { collectionOverdue, nextAttemptText } from './health';
import { useState } from 'react';
import { ConnectionChecks } from './ConnectionChecks';
import { dateTime } from './domain';
import { driverInfo } from './drivers';
import { formatMessage, localized, t } from './i18n';
import type { DriverInfo, Source } from './types';

/** Reading the diagnosis never runs a check; only the explicit button does. */
export function SourceDiagnosis({
  source,
  demo,
  drivers,
  collecting = false,
}: {
  source: Source;
  demo: boolean;
  drivers: DriverInfo[];
  collecting?: boolean;
}) {
  const [check, setCheck] = useState(0);
  const active = collecting || source.status === 'syncing';
  return (
    <div className="source-diagnosis">
      <header className="modal-header">
        <h2 id="modal-title">{t('attention.diagnosis', { name: source.name })}</h2>
        <p>{source.username || localized(driverInfo(drivers, source.driver).label)}</p>
      </header>
      <div className="source-diagnosis-body">
        <p>
          {source.last_success
            ? t('attention.lastSuccess', { time: dateTime(source.last_success) })
            : t('health.notCollected')}
        </p>
        <p>{nextAttemptText(source.next_due_at, active)}</p>
        <p>
          {formatMessage(source.error) ||
            t(
              collectionOverdue(source.next_due_at, active)
                ? 'health.overdueReason'
                : 'attention.noError',
            )}
        </p>
        {source.warnings?.map((warning, index) => (
          <p key={index}>{formatMessage(warning)}</p>
        ))}
        <button className="button" disabled={demo} onClick={() => setCheck(check + 1)}>
          {t('sources.testConnection')}
        </button>
        {demo && <p className="muted">{t('attention.exampleCheck')}</p>}
        {check > 0 && <ConnectionChecks key={check} sourceId={source.id} />}
      </div>
    </div>
  );
}
