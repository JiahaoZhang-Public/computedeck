import { useRouteParam } from '../useRouteParam';
import { Clock3, Copy, Plus } from 'lucide-react';
import { findGroup } from '../groups';
import { t } from '../i18n';
import type { MessageKey } from '../i18n';
import { dateTime, money, relativeTime } from '../domain';
import { jobReason } from '../jobFacts';
import { duration, planComparison, planFactors, RULES } from '../planExplanation';
import { gpuModels, idleInstances, machineOptions, planOptions } from '../plan';
import type { PlanOption, PlanRequest, Verdict } from '../plan';
import { Empty, GroupMark, Panel } from '../ui';
import type { Ctx } from './shared';
import type { NodeSummary } from '../types';

const TONES: Record<Verdict, string> = {
  likely: 'green',
  possible: 'amber',
  behind: 'wait',
  busy: 'red',
  limit: 'red',
  wall: 'red',
  unknown: 'gray',
  none: 'red',
  unavailable: 'red',
  denied: 'gray',
};

function verdictLabel(option: PlanOption, request: PlanRequest) {
  if (option.verdict !== 'none') return t(`plan.verdict.${option.verdict}`);
  return request.gpuType
    ? t('plan.verdict.none', { model: request.gpuType })
    : t('plan.verdict.noGpus');
}

function freeGpuCount(option: PlanOption, used = 0) {
  if (option.freeGpus == null) return '—';
  const count = option.freeGpus - used;
  return option.freeGpusPartial ? `≥ ${count}` : count;
}

function explain(option: PlanOption, request: PlanRequest, nodes: NodeSummary) {
  const parts: string[] = [];
  const key: Record<Verdict, MessageKey | null> = {
    // The numbers in the row already say why; repeating them only makes the row taller.
    likely: null,
    possible:
      option.headroom == null
        ? 'plan.why.possibleLimit'
        : option.freeGpus == null
          ? 'plan.why.possibleFree'
          : null,
    behind: 'plan.why.behind',
    busy: 'plan.why.busy',
    limit: 'plan.why.limit',
    wall: 'plan.why.wall',
    unknown: 'plan.why.unknown',
    unavailable: null,
    denied: 'plan.why.denied',
    none: request.gpuType ? 'plan.why.none' : 'plan.why.noGpus',
  };
  if (option.verdict === 'unavailable') {
    parts.push(
      t('summary.capacity', { usable: nodes.usable ?? '—', unavailable: nodes.unavailable ?? '—' }),
    );
  }
  const { rule } = option;
  const ruleText = rule && RULES[rule.kind][rule.effect];
  const reason = key[option.verdict];
  if (rule && ruleText)
    parts.push(t(ruleText, { count: rule.limit, limit: rule.limit, used: rule.used }));
  else if (reason)
    parts.push(
      t(reason, {
        free: freeGpuCount(option),
        headroom: option.headroom,
        queued: option.queuedForRoom,
        count: option.queuedForRoom,
        left: option.headroomAfterQueue == null ? '—' : Math.max(0, option.headroomAfterQueue),
        used: option.used,
        limit: option.limit,
        max: option.maxWallHours == null ? null : duration(option.maxWallHours),
        model: request.gpuType,
      }),
    );
  if (option.contradiction) parts.push(t('plan.why.contradiction', option.contradiction));
  if (option.onDemandGpus) parts.push(t('plan.why.onDemand', { count: option.onDemandGpus }));
  if (
    option.largestNodeFree != null &&
    option.freeGpus != null &&
    option.freeGpus >= request.gpus &&
    option.largestNodeFree < request.gpus
  )
    parts.push(t('plan.why.multiNode', { count: request.gpus }));
  if (
    (option.verdict === 'likely' || option.verdict === 'possible') &&
    option.queuedForRoom == null &&
    (option.queuedGpus == null ||
      (request.gpuType && option.headroom != null && option.headroomAfterQueue == null))
  )
    parts.push(t('plan.why.queueUnknown'));
  if (option.source.cluster_state === 'degraded') parts.push(t('plan.why.degraded'));
  return parts.join(' ');
}

export function PlanPage({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const [requestedGpus, setGpus] = useRouteParam('gpus', '1');
  const [gpuType, setGpuType] = useRouteParam('model');
  const [requestedHours, setHours] = useRouteParam('hours');
  const count = Number(requestedGpus);
  const gpus = Number.isInteger(count) && count >= 1 && count <= 1024 ? count : 1;
  const hours =
    Number.isFinite(Number(requestedHours)) && Number(requestedHours) >= 0 ? requestedHours : '';
  const request: PlanRequest = {
    gpus: Math.max(1, gpus || 1),
    gpuType,
    hours: hours.trim() ? Number(hours) : null,
  };
  const options = planOptions(data, request);
  const visible = options.filter((option) => option.access !== 'not_associated');
  const denied = options.filter((option) => option.access === 'not_associated');
  const unchecked = [
    ...new Map(
      visible
        .filter((option) => option.access === 'unknown')
        .map((option) => [option.source.id, option.source]),
    ).values(),
  ];
  const first = visible[0];
  const best = first && ['likely', 'possible'].includes(first.verdict) ? first : null;
  const machines = machineOptions(data, request);
  const visibleMachines = machines.filter(
    (option) => !request.gpuType || option.total > 0 || option.unknown > 0,
  );
  const unmatchedMachines = machines.length - visibleMachines.length;
  const models = gpuModels(
    data.nodes,
    machines.map((option) => option.instance),
  );
  const hasMachines = data.sources.some((source) => source.driver === 'ssh');
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
              onChange={(event) => setGpus(event.target.value)}
            />
          </label>
          <label>
            {t('plan.model')}
            <select value={gpuType} onChange={(event) => setGpuType(event.target.value)}>
              <option value="">{t('plan.anyModel')}</option>
              {(gpuType && !models.includes(gpuType) ? [gpuType, ...models] : models).map(
                (model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ),
              )}
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
      {best && (
        <Panel title={t('plan.best')}>
          <div className="plan-best">
            <strong>
              {best.source.name} · {best.source.username}
              {best.qos && ` · ${best.qos}`}
            </strong>
            <span className={`status ${TONES[best.verdict]}`}>
              <i />
              {verdictLabel(best, request)}
            </span>
            {best.access === 'unknown' && <span className="tag">{t('plan.accessUnchecked')}</span>}
            <span>
              {t('plan.best.free', {
                count: freeGpuCount(best, request.gpus),
              })}
            </span>
            <span>
              {t('plan.best.room', {
                count:
                  best.headroomAfterQueue == null
                    ? '—'
                    : best.headroomAfterQueue === Infinity
                      ? t('plan.noLimit')
                      : Math.max(0, best.headroomAfterQueue),
              })}
            </span>
            {best.largestNodeFree != null && best.largestNodeFree >= request.gpus && (
              <span>{t('plan.best.oneNode')}</span>
            )}
            {best.nodesObservedAt && (
              <span className="muted">
                {t('plan.nodesAt', { time: relativeTime(best.nodesObservedAt) })}
              </span>
            )}
            {visible[1] && (
              <p className="plan-comparison">{planComparison(best, visible[1], request)}</p>
            )}
          </div>
        </Panel>
      )}
      {(hasClusters || !hasMachines) && (
        <Panel title={t('plan.options')} count={visible.length}>
          {unchecked.map((source) => (
            <p className="panel-note" key={source.id}>
              {t('plan.accessNote', { source: `${source.name} · ${source.username}` })}
            </p>
          ))}
          {visible.length ? (
            <OptionsTable options={visible} request={request} ctx={ctx} />
          ) : (
            <Empty
              title={t(denied.length ? 'plan.noAccess' : 'plan.empty')}
              text={
                denied.length
                  ? t('plan.noAccessHint')
                  : hasClusters
                    ? t('plan.emptyDisabled')
                    : t('plan.emptyHint')
              }
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
      )}
      {denied.length > 0 && (
        <details className="panel">
          <summary>{t('plan.access.not_associated', { count: denied.length })}</summary>
          <OptionsTable options={denied} request={request} ctx={ctx} />
        </details>
      )}
      {hasMachines && (
        <Panel title={t('plan.machines')} count={visibleMachines.length}>
          <p className="panel-note">{t('plan.machinesNote')}</p>
          {unmatchedMachines > 0 && (
            <p className="panel-note">{t('plan.machinesNoMatch', { count: unmatchedMachines })}</p>
          )}
          {visibleMachines.length ? (
            <ul className="rows machine-options">
              {visibleMachines.map(({ instance, free, total, unknown, command }) => (
                <li key={instance.id} className={free < request.gpus ? 'muted' : undefined}>
                  <div className="grow">
                    <strong>
                      {instance.platform} · {instance.name}
                    </strong>
                    <span className="sub">
                      {t('plan.machineFree', { free: unknown ? `≥ ${free}` : free, total })}
                    </span>
                    {unknown > 0 && (
                      <span className="sub">{t('plan.machineUnknown', { count: unknown })}</span>
                    )}
                    <span className="sub" title={dateTime(instance.gpus_observed_at)}>
                      {t('gpu.sampled', { time: relativeTime(instance.gpus_observed_at) })}
                    </span>
                    {command && <pre className="machine-command">{command}</pre>}
                  </div>
                  <div className="machine-actions">
                    {command && (
                      <button
                        className="button small"
                        disabled={ctx.demo}
                        onClick={() => void ctx.copy(command)}
                      >
                        <Copy size={14} />
                        {free < request.gpus
                          ? t('plan.machineCopyPartial', { count: free, requested: request.gpus })
                          : t('plan.machineCopy')}
                      </button>
                    )}
                    <button className="button small" onClick={() => ctx.openInstance(instance)}>
                      {t('plan.open')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : machines.length === 0 ? (
            <p className="panel-note">{t('plan.machinesEmpty')}</p>
          ) : null}
          <p className="panel-note">{t('plan.machineFreshness')}</p>
          {machines.some((option) => option.command) && (
            <p className="panel-note">{t('plan.machineCopyNote')}</p>
          )}
        </Panel>
      )}
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

function OptionsTable({
  options,
  request,
  ctx,
}: {
  options: PlanOption[];
  request: PlanRequest;
  ctx: Ctx;
}) {
  const { groups } = ctx;
  return (
    <div className="table-wrap plan-options">
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
            const why = explain(option, request, ctx.data.summary.sources[option.source.id].nodes);
            const reason = option.reasons?.[0];
            const explanation = reason
              ? jobReason({ state: 'PENDING', reason }, option.source.driver)
              : null;
            return (
              <tr key={option.key}>
                <td>
                  <span className="with-mark">
                    <GroupMark group={findGroup(groups, option.source.cluster_id)} />
                    <span>
                      <strong>
                        {option.source.name}
                        {option.qos && <span className="tag plan-qos">{option.qos}</span>}
                        {option.access === 'unknown' && (
                          <span className="tag plan-qos">{t('plan.accessUnchecked')}</span>
                        )}
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
                  {freeGpuCount(option)}
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
                  {option.queued ?? '—'}
                  <span className="sub">
                    {option.queuedForRoom == null
                      ? t('plan.queueRoomUnknown')
                      : t('plan.queuedGpus', { count: option.queuedForRoom })}
                  </span>
                  {reason && (
                    <span className="sub" title={reason}>
                      {explanation && explanation.kind !== 'unknown'
                        ? t(`plan.queueReason.${explanation.kind}` as MessageKey)
                        : reason}
                    </span>
                  )}
                </td>
                <td className="num" data-label={t('plan.col.wall')}>
                  {option.maxWallHours == null ? '—' : duration(option.maxWallHours)}
                </td>
                <td className="plan-verdict">
                  <span className={`status ${TONES[option.verdict]}`}>
                    {option.verdict === 'behind' ? <Clock3 size={13} /> : <i />}
                    {verdictLabel(option, request)}
                  </span>
                  {why && <span className="sub plan-why">{why}</span>}
                  <PlanExplanation option={option} request={request} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PlanExplanation({ option, request }: { option: PlanOption; request: PlanRequest }) {
  return (
    <details className="plan-explanation">
      <summary>{t('plan.explanation')}</summary>
      <p className="sub">{t('plan.factor.note')}</p>
      <dl className="plan-factors">
        {planFactors(option, request).map((factor) => (
          <div key={factor.key}>
            <dt>{t(`plan.factor.${factor.key}`)}</dt>
            <dd>
              <span>{factor.value}</span>
              <span className="sub">{t(`plan.effect.${factor.effect}`)}</span>
              {[
                ...new Map(
                  factor.evidence.map((item) => [
                    `${item.source.id}:${item.capability}:${item.at}:${item.current}`,
                    item,
                  ]),
                ).values(),
              ].map((item) => (
                <span
                  className="sub"
                  key={`${item.source.id}:${item.capability}:${item.at}:${item.current}`}
                >
                  {t('plan.factor.source', {
                    source: `${item.source.name} · ${item.source.username}`,
                    capability: t(`plan.factor.capability.${item.capability}`),
                    age: item.at ? relativeTime(item.at) : t('status.unknown'),
                    state: t(item.current ? 'plan.factor.current' : 'plan.factor.notCurrent'),
                  })}
                  {item.at && (
                    <time className="sub" dateTime={item.at}>
                      {dateTime(item.at)}
                    </time>
                  )}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
