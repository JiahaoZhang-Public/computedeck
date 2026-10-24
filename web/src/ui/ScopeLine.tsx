import { formatMessage, t, type Message } from '../i18n';
import { Time } from './Time';
import './display.css';

export interface RuleTrace {
  rule: Message | string;
  included: string[];
  excluded: { source: string; reason: Message | string }[];
  as_of: string | null;
}
export function ScopeLine({
  scope,
  groups,
  asOf,
  estimate = false,
}: {
  scope: string;
  groups: string;
  asOf: string | null;
  estimate?: boolean;
}) {
  return (
    <p className="scope-line">
      <strong>{scope}</strong> · {groups} · {t('display.asOf')} <Time value={asOf} />
      {estimate && <> · {t('display.estimate')}</>}
    </p>
  );
}
export function HowWorkedOut({ trace }: { trace: RuleTrace }) {
  return (
    <details className="how-worked-out">
      <summary>{t('display.how')}</summary>
      <p>{formatMessage(trace.rule)}</p>
      <dl>
        <dt>{t('display.included')}</dt>
        <dd>{trace.included.join(', ') || t('display.none')}</dd>
        <dt>{t('display.excluded')}</dt>
        <dd>
          {trace.excluded.length ? (
            <ul>
              {trace.excluded.map(({ source, reason }) => (
                <li key={source}>
                  {source} · {formatMessage(reason)}
                </li>
              ))}
            </ul>
          ) : (
            t('display.none')
          )}
        </dd>
        <dt>{t('display.asOf')}</dt>
        <dd>
          <Time value={trace.as_of} />
        </dd>
      </dl>
    </details>
  );
}
