import { Fragment, useEffect, useState } from 'react';
import { setRouteParams, useRouteParam } from '../useRouteParam';
import { canCopySubmit, jobPlanRequest, jobWaitsHere, planPresets, submitFlags } from '../submit';
import type { SubmitFormat } from '../submit';
import { Clock3, Copy, Plus, X } from 'lucide-react';
import { findGroup } from '../groups';
import { locale, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { dateTime, relativeTime, sourceHasData, uniqueNodes } from '../domain';
import { jobReason } from '../jobFacts';
import { duration, planComparison, planFactors, RULES, type PlanFactor } from '../planExplanation';
import { gpuModels, lowUseInstances, machineOptions, machineSamples, planOptions } from '../plan';
import type { PlanOption, PlanRequest, Verdict } from '../plan';
import { Chips, Empty, GroupMark, Panel } from '../ui';
import type { Ctx } from './shared';
import type { Job, NodeSummary } from '../types';
import { WaitHistory, WaitHistoryNote } from '../WaitHistory';

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
  return parts.join(locale() === 'zh-CN' ? '' : ' ');
}

export function PlanPage({ ctx }: { ctx: Ctx }) {
  const { data } = ctx;
  const [from, setFrom] = useRouteParam('from');
  const jobs = [...data.jobs, ...(data.recent_failures ?? [])];
  const fromJob = jobs.find((job) => job.id === from);
  const preset = fromJob ? jobPlanRequest(fromJob, data.nodes) : null;
  const [requestedGpus] = useRouteParam('gpus');
  const [format, setFormat] = useState<SubmitFormat>(() => {
    try {
      return localStorage.getItem('computedeck.submitFormat') === 'header' ? 'header' : 'line';
    } catch {
      return 'line';
    }
  });
  const presets = planPresets(data);
  const [requestedModel] = useRouteParam('model');
  const gpuType = requestedModel || (!requestedGpus ? (preset?.gpuType ?? '') : '');
  const [requestedHours] = useRouteParam('hours');
  const count = Number(requestedGpus || preset?.gpus || 1);
  const gpus = Number.isInteger(count) && count >= 1 && count <= 1024 ? count : 1;
  const hours =
    Number.isFinite(Number(requestedHours)) && Number(requestedHours) >= 0 ? requestedHours : '';
  const request: PlanRequest = {
    gpus: Math.max(1, gpus || 1),
    gpuType,
    hours: hours.trim() ? Number(hours) : null,
  };
  // Resolve from-only links once; explicit inputs then survive polling and job expiry.
  useEffect(() => {
    if (fromJob && !requestedGpus) {
      setRouteParams({ gpus: String(request.gpus), model: gpuType });
    }
  }, [fromJob, requestedGpus, request.gpus, gpuType]);
  function changeRequest(values: Record<string, string | null>) {
    // Keep an empty edit from turning the URL back into an unresolved job link.
    setRouteParams({ model: gpuType, hours, ...values, gpus: values.gpus || String(gpus) });
  }
  function changeFormat(value: SubmitFormat) {
    setFormat(value);
    try {
      localStorage.setItem('computedeck.submitFormat', value);
    } catch {
      // Copying still works when browser storage is unavailable.
    }
  }
  const options = planOptions(data, request);
  const currentSources = new Map(
    data.sources
      .filter((source) => sourceHasData(source, 'jobs'))
      .map((source) => [source.id, source]),
  );
  const jobsByLogin = new Map<string, Job[]>();
  const currentJobs = data.jobs.filter((job) => {
    const source = currentSources.get(job.source_id);
    return source?.cluster_id === job.cluster_id && source.username === job.user;
  });
  for (const job of [...currentJobs, ...(data.recent_failures ?? [])]) {
    const key = JSON.stringify([job.cluster_id, job.user]);
    const own = jobsByLogin.get(key);
    if (own) own.push(job);
    else jobsByLogin.set(key, [job]);
  }
  const nodes = uniqueNodes(data.nodes);
  const submissions = new Map(
    options.map((option) => [
      option.key,
      submitFlags(
        option,
        request,
        jobsByLogin.get(JSON.stringify([option.source.cluster_id, option.source.username])) ?? [],
        nodes,
        format,
      ),
    ]),
  );
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
  const { staleCount } = machineSamples(data);
  const visibleMachines = machines.filter(
    (option) => !request.gpuType || option.total > 0 || option.unknown > 0,
  );
  const unmatchedMachines = machines.length - visibleMachines.length;
  const models = gpuModels(
    data.nodes,
    machines.map((option) => option.instance),
  );
  const hasMachines = data.sources.some((source) => source.driver === 'ssh');
  const lowUse = lowUseInstances(data.instances);
  const hasClusters = data.sources.some((source) => source.kind === 'cluster');
  return (
    <>
      <Panel>
        {from && (
          <div className="plan-from">
            <span>
              {fromJob
                ? fromJob.gpu_count != null && fromJob.gpu_count > 0
                  ? t('plan.forJob', { name: fromJob.name, count: fromJob.gpu_count })
                  : t('plan.forJob.nameOnly', { name: fromJob.name })
                : t('plan.fromMissing', { id: from })}
              {fromJob && (fromJob.gpu_count == null || fromJob.gpu_count < 1) && (
                <span className="sub">{t('plan.fromUnknown')}</span>
              )}
            </span>
            <button
              className="icon-button"
              aria-label={t('plan.clearFrom')}
              onClick={() => setFrom('')}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {presets.length > 0 && (
          <div className="plan-presets" role="group" aria-label={t('plan.presets')}>
            <span className="muted">{t('plan.presets')}</span>
            {presets.map((job) => {
              const next = jobPlanRequest(job, data.nodes);
              return (
                <button
                  key={`${job.source_id}:${job.id}`}
                  className="button small"
                  onClick={() => {
                    changeRequest({
                      gpus: String(next.gpus),
                      model: next.gpuType,
                      hours: null,
                      from: job.id,
                    });
                  }}
                >
                  {t(next.gpuType ? 'plan.preset' : 'plan.preset.noModel', {
                    count: next.gpus,
                    model: next.gpuType,
                    name: job.name,
                  })}
                </button>
              );
            })}
          </div>
        )}
        <form className="plan-form" onSubmit={(event) => event.preventDefault()}>
          <label>
            {t('plan.gpus')}
            <input
              type="number"
              min="1"
              max="1024"
              value={gpus}
              onChange={(event) => changeRequest({ gpus: event.target.value })}
            />
          </label>
          <label>
            {t('plan.model')}
            <select
              value={gpuType}
              onChange={(event) => changeRequest({ model: event.target.value })}
            >
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
              onChange={(event) => changeRequest({ hours: event.target.value })}
            />
          </label>
        </form>
      </Panel>
      {options.some(canCopySubmit) && (
        <div className="plan-copy-format">
          <span>{t('plan.submit.format')}</span>
          <Chips<SubmitFormat>
            label={t('plan.submit.format')}
            value={format}
            onChange={changeFormat}
            options={[
              { value: 'line', label: t('plan.submit.line') },
              { value: 'header', label: t('plan.submit.header') },
            ]}
          />
        </div>
      )}
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
            <SubmitCopy result={submissions.get(best.key)!} ctx={ctx} option={best} />
            {visible[1] && (
              <p className="plan-comparison">{planComparison(best, visible[1], request)}</p>
            )}
            <WaitHistory
              compact
              history={data.wait_history?.[best.source.id]}
              qos={best.qos}
              gpus={request.gpus}
            />
            <WaitHistoryNote histories={[data.wait_history?.[best.source.id]]} relative />
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
            <OptionsTable
              options={visible}
              request={request}
              ctx={ctx}
              submissions={submissions}
              fromJob={fromJob}
            />
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
          {visible.length > 0 && (
            <div className="panel-note">
              <WaitHistoryNote
                histories={visible.map((o) => data.wait_history?.[o.source.id])}
                relative
              />
            </div>
          )}
          <p className="panel-note">{t('plan.note')}</p>
        </Panel>
      )}
      {denied.length > 0 && (
        <details className="panel">
          <summary>{t('plan.access.not_associated', { count: denied.length })}</summary>
          <OptionsTable
            options={denied}
            request={request}
            ctx={ctx}
            submissions={submissions}
            fromJob={fromJob}
          />
          <div className="panel-note">
            <WaitHistoryNote
              histories={denied.map((o) => data.wait_history?.[o.source.id])}
              relative
            />
          </div>
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
                    {command && (
                      <pre
                        className="machine-command"
                        tabIndex={0}
                        aria-label={t('plan.machineCommandFor', { name: instance.name })}
                      >
                        {command}
                      </pre>
                    )}
                  </div>
                  <div className="machine-actions">
                    {command && (
                      <button
                        className="button small"
                        aria-label={t('plan.machineCopyFor', { name: instance.name })}
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
          {staleCount > 0 && (
            <p className="panel-note">{t('plan.machinesStale', { count: staleCount })}</p>
          )}
          <p className="panel-note">{t('plan.machineFreshness')}</p>
          {machines.some((option) => option.command) && (
            <p className="panel-note">{t('plan.machineCopyNote')}</p>
          )}
        </Panel>
      )}
      {lowUse.length > 0 && (
        <a className="link" href="#/cloud?use=low">
          {t('lowUse.pointer', { count: lowUse.length })}
        </a>
      )}
    </>
  );
}

function OptionsTable({
  options,
  request,
  ctx,
  submissions,
  fromJob,
}: {
  submissions: Map<string, ReturnType<typeof submitFlags>>;
  fromJob?: Job;
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
              <Fragment key={option.key}>
                <tr className="plan-option-row">
                  <td>
                    <span className="with-mark">
                      <GroupMark group={findGroup(groups, option.source.cluster_id)} />
                      <span>
                        <strong>
                          {option.source.name}
                          {jobWaitsHere(fromJob, option) && (
                            <span className="tag plan-qos">{t('plan.waitsHere')}</span>
                          )}
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
                    <WaitHistory
                      compact
                      history={ctx.data.wait_history?.[option.source.id]}
                      qos={option.qos}
                      gpus={request.gpus}
                    />
                    <SubmitCopy result={submissions.get(option.key)!} ctx={ctx} option={option} />
                  </td>
                </tr>
                <tr className="plan-explanation-row">
                  <td colSpan={6}>
                    <PlanExplanation option={option} request={request} />
                  </td>
                </tr>
              </Fragment>
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
      <summary aria-label={t('plan.explanationFor', { name: optionName(option) })}>
        {t('plan.explanation')}
      </summary>
      <p className="sub">{t('plan.factor.note')}</p>
      <dl className="plan-factors">
        {planFactors(option, request).map((factor) => (
          <div key={factor.key}>
            <dt>{t(`plan.factor.${factor.key}`)}</dt>
            <dd>
              <span>{factor.value}</span>
              <span className="sub">{t(`plan.effect.${factor.effect}`)}</span>
              <FactorSources factor={factor} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function optionName(option: PlanOption) {
  return [option.source.name, option.source.username, option.qos].filter(Boolean).join(' · ');
}

function FactorSources({ factor }: { factor: PlanFactor }) {
  const evidence = [
    ...new Map(
      factor.evidence.map((item) => [
        `${item.source.id}:${item.capability}:${item.at}:${item.current}`,
        item,
      ]),
    ).values(),
  ];
  if (factor.key === 'age') evidence.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const source = (item: (typeof evidence)[number]) => (
    <span className="sub" key={`${item.source.id}:${item.capability}:${item.at}:${item.current}`}>
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
  );
  return factor.key === 'age' && evidence.length > 1 ? (
    <>
      {source(evidence[0])}
      <details>
        <summary>{t('plan.factor.allSources')}</summary>
        {evidence.map(source)}
      </details>
    </>
  ) : (
    evidence.map(source)
  );
}

function SubmitCopy({
  result,
  ctx,
  option,
}: {
  result: ReturnType<typeof submitFlags>;
  ctx: Ctx;
  option: PlanOption;
}) {
  if (!result) return null;
  return (
    <div className="plan-submit">
      <button
        className="button small"
        aria-label={t('plan.submit.copyFor', { name: optionName(option) })}
        onClick={() => void ctx.copy(result.text, t('plan.submit.copied'))}
      >
        <Copy size={14} /> {t('plan.submit.copy')}
      </button>
      {result.notes.map((note) => (
        <span className="sub" key={note}>
          {note}
        </span>
      ))}
    </div>
  );
}
