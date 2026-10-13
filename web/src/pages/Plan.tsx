import { useState } from 'react';
import { Plus } from 'lucide-react';
import { findGroup } from '../groups';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { money, relativeTime } from '../domain';
import { gpuModels, idleInstances, planOptions } from '../plan';
import type { PlanOption, PlanRequest, QosRule, Verdict } from '../plan';
import { Empty, GroupMark, Panel } from '../ui';
import type { Ctx } from './shared';

const TONES: Record<Verdict, string> = {
  likely: 'green',
  possible: 'amber',
  busy: 'red',
  limit: 'red',
  wall: 'red',
  unknown: 'gray',
  none: 'red',
};

/** Why a QoS rule decided the estimate. */
const RULES: Record<QosRule['kind'], Partial<Record<QosRule['effect'], MessageKey>>> = {
  perJob: { limit: 'plan.why.perJob' },
  jobs: { limit: 'plan.why.jobs' },
  submit: { limit: 'plan.why.submit' },
  group: {
    limit: 'plan.why.groupLimit',
    busy: 'plan.why.groupBusy',
    doubt: 'plan.why.groupUnknown',
  },
  typed: { doubt: 'plan.why.typed' },
};

function verdictLabel(option: PlanOption, request: PlanRequest) {
  if (option.verdict !== 'none') return t(`plan.verdict.${option.verdict}`);
  return request.gpuType
    ? t('plan.verdict.none', { model: request.gpuType })
    : t('plan.verdict.noGpus');
}

function duration(hours: number) {
  return hours >= 48 && hours % 24 === 0
    ? t('plan.days', { count: hours / 24 })
    : t('plan.hours', { count: Math.round(hours * 10) / 10 });
}

function explain(option: PlanOption, request: PlanRequest) {
  const parts: string[] = [];
  const key: Record<Verdict, MessageKey | null> = {
    // The numbers in the row already say why; repeating them only makes the row taller.
    likely: null,
    possible: option.freeGpus != null ? 'plan.why.possibleLimit' : 'plan.why.possibleFree',
    busy: 'plan.why.busy',
    limit: 'plan.why.limit',
    wall: 'plan.why.wall',
    unknown: 'plan.why.unknown',
    none: request.gpuType ? 'plan.why.none' : 'plan.why.noGpus',
  };
  const { rule } = option;
  const ruleText = rule && RULES[rule.kind][rule.effect];
  const reason = key[option.verdict];
  if (rule && ruleText)
    parts.push(t(ruleText, { count: rule.limit, limit: rule.limit, used: rule.used }));
  else if (reason)
    parts.push(
      t(reason, {
        free: option.freeGpus,
        headroom: option.headroom,
        used: option.used,
        limit: option.limit,
        max: option.maxWallHours == null ? null : duration(option.maxWallHours),
        model: request.gpuType,
      }),
    );
  if (
    option.largestNodeFree != null &&
    option.freeGpus != null &&
    option.freeGpus >= request.gpus &&
    option.largestNodeFree < request.gpus
  )
    parts.push(t('plan.why.multiNode', { count: request.gpus }));
  return parts.join(' ');
}

export function PlanPage({ ctx }: { ctx: Ctx }) {
  const { data, groups } = ctx;
  const [gpus, setGpus] = useState(1);
  const [gpuType, setGpuType] = useState('');
  const [hours, setHours] = useState('');
  const request: PlanRequest = {
    gpus: Math.max(1, gpus || 1),
    gpuType,
    hours: hours.trim() ? Number(hours) : null,
  };
  const options = planOptions(data, request);
  const models = gpuModels(data.nodes);
  const idle = idleInstances(data.instances);
  const hasClusters = data.sources.some((source) => source.kind === 'cluster');
  return (
    <>
      <Panel>
        <form className="plan-form" onSubmit={(event) => event.preventDefault()}>
          <label>
            {t('plan.gpus')}
            <input
              type="number"
              min="1"
              max="1024"
              value={gpus}
              onChange={(event) => setGpus(Number(event.target.value))}
            />
          </label>
          <label>
            {t('plan.model')}
            <select value={gpuType} onChange={(event) => setGpuType(event.target.value)}>
              <option value="">{t('plan.anyModel')}</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              {t('plan.runtime')} <small>{t('common.optional')}</small>
            </span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={hours}
              placeholder="24"
              onChange={(event) => setHours(event.target.value)}
            />
          </label>
        </form>
      </Panel>
      <Panel title={t('plan.options')} count={options.length}>
        {options.length ? (
          <div className="table-wrap">
            <table className="table plan-table">
              <thead>
                <tr>
                  <th>{t('plan.col.where')}</th>
                  <th className="num">{t('plan.col.free')}</th>
                  <th className="num">{t('plan.col.limit')}</th>
                  <th className="num">{t('plan.col.queued')}</th>
                  <th className="num">{t('plan.col.wall')}</th>
                  <th>{t('plan.col.verdict')}</th>
                </tr>
              </thead>
              <tbody>
                {options.map((option) => {
                  const why = explain(option, request);
                  return (
                    <tr key={option.key}>
                      <td>
                        <span className="with-mark">
                          <GroupMark group={findGroup(groups, option.source.cluster_id)} />
                          <span>
                            <strong>
                              {option.source.name}
                              {option.qos && <span className="tag plan-qos">{option.qos}</span>}
                            </strong>
                            <span className="sub">
                              {option.source.username}
                              {option.nodesObservedAt &&
                                ` · ${t('plan.nodesAt', { time: relativeTime(option.nodesObservedAt) })}`}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="num" data-label={t('plan.col.free')}>
                        {option.freeGpus ?? '—'}
                        {option.largestNodeFree != null && (
                          <span className="sub">
                            {t('plan.largestNode', { count: option.largestNodeFree })}
                          </span>
                        )}
                      </td>
                      <td className="num" data-label={t('plan.col.limit')}>
                        {option.limit === Infinity ? t('plan.noLimit') : (option.limit ?? '—')}
                        {option.used != null && option.limit != null && (
                          <span className="sub">{t('plan.inUse', { count: option.used })}</span>
                        )}
                      </td>
                      <td className="num" data-label={t('plan.col.queued')}>
                        {option.queued}
                        {option.reasons[0] && <span className="sub">{option.reasons[0]}</span>}
                      </td>
                      <td className="num" data-label={t('plan.col.wall')}>
                        {option.maxWallHours == null ? '—' : duration(option.maxWallHours)}
                      </td>
                      <td className="plan-verdict">
                        <span className={`status ${TONES[option.verdict]}`}>
                          <i />
                          {verdictLabel(option, request)}
                        </span>
                        {why && <span className="sub plan-why">{why}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={t('plan.empty')}
            text={hasClusters ? t('plan.emptyDisabled') : t('plan.emptyHint')}
            action={
              hasClusters || ctx.demo ? undefined : (
                <button
                  className="button primary"
                  onClick={() => ctx.configure(undefined, { kind: 'cluster' })}
                >
                  <Plus size={14} /> {t('clusters.add')}
                </button>
              )
            }
          />
        )}
        <p className="panel-note">{t('plan.note')}</p>
      </Panel>
      {idle.length > 0 && (
        <Panel title={t('plan.idle')} count={idle.length}>
          <ul className="rows">
            {idle.map((item) => (
              <li key={item.id}>
                <div className="grow">
                  <strong>{item.name}</strong>
                  <span className="sub">
                    {item.platform} · {item.gpu_count} × {item.gpu_type || 'GPU'} ·{' '}
                    {t('plan.idleUtil', { value: Math.round(item.gpu_utilization ?? 0) })}
                  </span>
                </div>
                <span className="muted">
                  {item.hourly_cost == null ? '' : `${money(item.hourly_cost, item.currency)}/h`}
                </span>
                <button className="button small" onClick={() => ctx.openInstance(item)}>
                  {t('plan.open')}
                </button>
              </li>
            ))}
          </ul>
          <p className="panel-note">{t('plan.idleNote')}</p>
        </Panel>
      )}
    </>
  );
}
