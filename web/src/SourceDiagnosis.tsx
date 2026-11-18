import { useSourceInFlight } from './sourceActions';
import { ClockText } from './data/ClockText';
import { collectionOverdue } from './health';
import { useState } from 'react';
import { Ellipsis, X } from 'lucide-react';
import { ConnectionChecks } from './ConnectionChecks';
import { dateTime, money } from './domain';
import { driverInfo, fieldValue, primaryField } from './drivers';
import { formatMessage, localized, t } from './i18n';
import { sourceState } from './labels';
import { LazyMenuButton } from './pages/LazyMenu';
import { Status } from './ui';
import type { CollectionNode, DriverInfo, Source } from './types';

/**
 * A source's detail, with the same anatomy as a job's: the name and its state, one action row,
 * the error as lead text (the "why" the list does not show), key figures, then what it reads.
 * Reading it never runs a check; only the Test connection button does.
 */
export function SourceDiagnosis({
  source,
  demo,
  drivers,
  nodes = [],
  collecting = false,
  configure,
  collect,
  pause,
  snooze = [],
  close,
}: {
  source: Source;
  demo: boolean;
  drivers: DriverInfo[];
  nodes?: CollectionNode[];
  collecting?: boolean;
  configure?: () => void;
  collect?: () => Promise<void>;
  pause?: () => Promise<void>;
  /** Snooze entries for the source's attention item, when it has one. */
  snooze?: { id: string; label: string; action: () => void }[];
  close?: () => void;
}) {
  const inFlight = useSourceInFlight();
  const [check, setCheck] = useState(0);
  const active = collecting || source.status === 'syncing';
  const info = driverInfo(drivers, source.driver);
  const primary = primaryField(info);
  const reference = primary ? fieldValue(source, primary.key) : '';
  const route = nodes.find((node) => node.id === source.node);
  const busy = active || !!inFlight[source.id];
  const menu = [
    ...(collect
      ? [
          {
            id: 'collect',
            label: t('sources.collectNow'),
            disabled: demo || busy || !source.enabled,
            action: () => void collect(),
          },
        ]
      : []),
    ...(configure
      ? [{ id: 'configure', label: t('common.configure'), disabled: demo, action: configure }]
      : []),
    ...(pause
      ? [
          {
            id: 'pause',
            label: t(source.enabled ? 'sources.pause' : 'sources.resume'),
            disabled: demo || !!inFlight[source.id],
            action: () => void pause(),
          },
        ]
      : []),
    ...snooze,
  ];
  return (
    <div className="source-diagnosis">
      <header className="drawer-header">
        <div>
          <span className="drawer-kind">
            {t('nav.sources')}
            <span aria-hidden="true"> ›</span>
          </span>
          <div className="drawer-title">
            <h2 id="modal-title" tabIndex={-1}>
              {source.name}
            </h2>
            <Status state={sourceState(source)} />
          </div>
          <div className="drawer-chips">
            <code className="drawer-id">{localized(info.label)}</code>
            {reference && <code className="drawer-id">{reference}</code>}
          </div>
        </div>
        {close && (
          <button className="icon-button" aria-label={t('common.close')} onClick={close}>
            <X size={16} />
          </button>
        )}
      </header>
      <div className="drawer-body">
        <div className="drawer-actions">
          <button
            className="button primary"
            disabled={demo || busy}
            onClick={() => setCheck(check + 1)}
          >
            {t('sources.testConnection')}
          </button>
          {menu.length > 0 && (
            <LazyMenuButton className="icon-button" aria-label={t('drawer.more')} items={menu}>
              <Ellipsis size={16} />
            </LazyMenuButton>
          )}
        </div>
        <ClockText>
          {() => {
            const why =
              formatMessage(source.error) ||
              (collectionOverdue(source.next_due_at, active) ? t('health.overdueReason') : '');
            return (
              why && (
                <div className="callout red">
                  <p className="lead">{why}</p>
                </div>
              )
            );
          }}
        </ClockText>
        {source.warnings
          ?.filter(
            (warning) =>
              !info.checks.some(
                (item) => typeof warning !== 'string' && item.warning === warning.code,
              ),
          )
          .map((warning, index) => (
            <div key={index} className="callout amber">
              <p>{formatMessage(warning)}</p>
            </div>
          ))}
        <dl className="figures">
          <div>
            <dt>{t('clusters.col.lastSuccess')}</dt>
            <dd>{source.last_success ? dateTime(source.last_success) : '—'}</dd>
          </div>
          <div>
            <dt>{t('sources.nextTry')}</dt>
            <dd>{source.enabled && source.next_due_at ? dateTime(source.next_due_at) : '—'}</dd>
          </div>
          <div>
            <dt>{t('clusters.col.interval')}</dt>
            <dd>{t('common.minutes', { count: source.interval_minutes })}</dd>
          </div>
          <div>
            <dt>{t('sources.col.route')}</dt>
            <dd>{source.node ? (route?.name ?? source.node) : t('routes.kind.direct')}</dd>
          </div>
          {source.account?.balance != null && (
            <div>
              <dt>{t('sources.col.balance')}</dt>
              <dd>{money(source.account.balance, source.account.currency)}</dd>
            </div>
          )}
        </dl>
        {info.checks.length > 0 && (
          <section className="source-reads" aria-label={t('sources.col.reads')}>
            <h3>{t('sources.col.reads')}</h3>
            <ul>
              {info.checks.map((item) => {
                const state = !source.last_success
                  ? 'pending'
                  : source.capabilities.includes(item.capability)
                    ? 'ok'
                    : 'missing';
                const notice = source.warnings?.find(
                  (warning) => typeof warning !== 'string' && warning.code === item.warning,
                );
                return (
                  <li key={item.capability} className={`capability ${state}`}>
                    <code>{item.command}</code>
                    <span>{localized(item.label)}</span>
                    <span>{t(`sources.capability.${state}`)}</span>
                    {notice && <span className="muted">{formatMessage(notice)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {check > 0 && <ConnectionChecks key={check} sourceId={source.id} />}
      </div>
    </div>
  );
}
