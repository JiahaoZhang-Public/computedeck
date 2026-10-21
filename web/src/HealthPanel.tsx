import { useEffect } from 'react';
import { X } from 'lucide-react';
import { dateTime, relativeTime } from './domain';
import { formatMessage, t } from './i18n';
import { groupsOf, sourceLabel } from './groups';
import { computeHealth, nextAttemptText } from './health';
import { Status } from './ui';
import { useDialogFocus } from './useDialogFocus';
import type { Dashboard } from './types';

export function HealthPanel({
  state,
  data,
  busy,
  refresh,
  close,
  addSource,
}: {
  state: ReturnType<typeof computeHealth>;
  data: Dashboard | null;
  busy: boolean;
  refresh: (sourceId?: string) => Promise<void>;
  close: () => void;
  addSource?: () => void;
}) {
  const ref = useDialogFocus();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  const groups = groupsOf(data ?? { sources: [], instances: [] });
  return (
    <div className="overlay health-overlay" onMouseDown={close}>
      <section
        className="modal health-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="health-title"
        tabIndex={-1}
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button modal-close" aria-label={t('common.close')} onClick={close}>
          <X size={16} />
        </button>
        <h2 id="health-title">{t('health.title')}</h2>
        <p>
          {state.label === state.age
            ? state.age
            : t('health.withAge', { label: state.label, age: state.age })}
        </p>
        {state.faults.map((fault) => (
          <div className="health-row" key={fault.id}>
            <strong>{fault.title}</strong>
            {fault.at && <p>{dateTime(fault.at)}</p>}
            <details>
              <summary>{t('health.details')}</summary>
              <p>{fault.detail}</p>
            </details>
            {fault.page && (
              <a href={`#/${fault.page}`} onClick={close}>
                {t(fault.page === 'sources' ? 'nav.sources' : 'nav.toolbox')}
              </a>
            )}
          </div>
        ))}
        {state.rows.map(({ source, state: sourceStatus, collecting }) => (
          <div className="health-row" key={source.id}>
            <div className="health-row-heading">
              <strong>{sourceLabel(groups, source)}</strong>
              <Status state={sourceStatus} />
            </div>
            <p title={source.last_success ?? ''}>
              {t('health.lastSuccess', {
                time: source.last_success
                  ? relativeTime(source.last_success)
                  : t('health.notCollected'),
              })}
            </p>
            {source.enabled && (
              <p>
                {source.status === 'syncing'
                  ? t('health.collectingSince', { time: dateTime(source.last_attempt) })
                  : collecting
                    ? t('health.queued')
                    : nextAttemptText(source.next_due_at, collecting)}
                {!collecting &&
                  (source.failures ?? 0) > 0 &&
                  ` · ${t('health.backoff', { count: source.failures })}`}
              </p>
            )}
            {source.error && (
              <details>
                <summary>{t('health.details')}</summary>
                <p>{formatMessage(source.error)}</p>
              </details>
            )}
            {(['jobs', 'nodes', 'instances'] as const)
              .filter((inventory) => !source.capabilities.includes(inventory))
              .map((inventory) => {
                const retained =
                  data?.[inventory].filter((row) => row.source_id === source.id) ?? [];
                if (!retained.length) return null;
                const times = retained.map((row) => row.observed_at);
                const oldest = times.every(Boolean)
                  ? (times as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
                  : null;
                return (
                  <p key={inventory}>
                    {t('health.retained', {
                      inventory: t(`health.inventory.${inventory}`),
                      time: oldest ? relativeTime(oldest) : t('health.unknown'),
                    })}
                  </p>
                );
              })}
            {source.enabled && (
              <button
                className="link"
                aria-label={t('health.retrySource', { name: sourceLabel(groups, source) })}
                disabled={busy}
                onClick={() => void refresh(source.id)}
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        ))}
        {!state.rows.length && <p>{t('health.noSources')}</p>}
        {state.rows.length ? (
          <button className="button" disabled={busy} onClick={() => void refresh()}>
            {t('health.collectAll')}
          </button>
        ) : addSource ? (
          <button className="button" onClick={addSource}>
            {t('source.add')}
          </button>
        ) : null}
      </section>
    </div>
  );
}
