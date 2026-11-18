import { useClock } from '../ui/clock';
import { ClockText } from '../data/ClockText';
import { Fragment, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { setRouteParams, useRouteParam } from '../useRouteParam';
import { jobPlanRequest, jobWaitsHere, planPresets, submitFlags } from '../submit';
import type { SubmitFormat } from '../submit';
import { ChevronDown, Clock3, X } from 'lucide-react';
import { locale, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { dateTime, relativeTime, sourceHasData, uniqueNodes } from '../domain';
import { jobReason } from '../jobFacts';
import { duration, planComparison, planFactors, RULES, type PlanFactor } from '../planExplanation';
import { gpuModels, lowUseInstances, machineOptions, machineSamples, planOptions } from '../plan';
import type { PlanOption, PlanRequest, Verdict } from '../plan';
import { Empty, Panel } from '../ui';
import { LazyMenuButton } from './LazyMenu';
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

/** Access not checked means the estimate is not known either; the explanation says why. */
function shownVerdict(option: PlanOption): Verdict {
  return option.access === 'unknown' ? 'unknown' : option.verdict;
}

function verdictLabel(option: PlanOption, request: PlanRequest) {
  const verdict = shownVerdict(option);
  if (verdict !== 'none') return t(`plan.verdict.${verdict}`);
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
  // Machine eligibility expires with sample age even when no collection arrives.
  useClock();
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
  const copyFormat = { value: format, change: changeFormat };
  const visible = options.filter((option) => option.access !== 'not_associated');
  const denied = options.filter((option) => option.access === 'not_associated');
  // Options that cannot run as asked stay listed, with reasons, behind one disclosure.
  const unfitVerdicts: Verdict[] = ['none', 'unavailable', 'wall', 'limit'];
  const fitting = visible.filter((option) => !unfitVerdicts.includes(option.verdict));
  const unfit = visible.filter((option) => unfitVerdicts.includes(option.verdict));
  const first = visible[0];
  const best = first && ['likely', 'possible'].includes(shownVerdict(first)) ? first : null;
  const machines = machineOptions(data, request, undefined, ctx.nodes);
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
            <dl className="figures">
              <div>
                <dt>{t('plan.tile.free')}</dt>
                <dd>{freeGpuCount(best, request.gpus)}</dd>
              </div>
              <div>
                <dt>{t('plan.tile.room')}</dt>
                <dd>
                  {best.headroomAfterQueue == null
                    ? '—'
                    : best.headroomAfterQueue === Infinity
                      ? t('plan.noLimit')
                      : Math.max(0, best.headroomAfterQueue)}
                </dd>
              </div>
              <div>
                <dt>{t('plan.tile.node')}</dt>
                <dd>{best.largestNodeFree ?? '—'}</dd>
              </div>
            </dl>
            <SubmitCopy
              result={submissions.get(best.key)!}
              ctx={ctx}
              option={best}
              format={copyFormat}
            />
            <details className="plan-details">
              <summary>{t('plan.details')}</summary>
              <SubmitNotes result={submissions.get(best.key)} />
              {visible[1] && (
                <p className="plan-comparison">{planComparison(best, visible[1], request)}</p>
              )}
              {best.nodesObservedAt && (
                <p className="sub">
                  <ClockText>
                    {() => t('plan.nodesAt', { time: relativeTime(best.nodesObservedAt) })}
                  </ClockText>
                </p>
              )}
              <WaitHistory
                compact
                history={data.wait_history?.[best.source.id]}
                qos={best.qos}
                gpus={request.gpus}
              />
              <WaitHistoryNote histories={[data.wait_history?.[best.source.id]]} relative />
            </details>
          </div>
        </Panel>
      )}
      {(hasClusters || !hasMachines) && (
        <Panel title={t('plan.options')}>
          {visible.length ? (
            <>
              {fitting.length > 0 && (
                <OptionsTable
                  options={fitting}
                  request={request}
                  ctx={ctx}
                  submissions={submissions}
                  format={copyFormat}
                  fromJob={fromJob}
                />
              )}
              {unfit.length > 0 && (
                <details className="plan-unfit" open={!fitting.length || undefined}>
                  <summary>{t('plan.unfit', { count: unfit.length })}</summary>
                  <OptionsTable
                    options={unfit}
                    request={request}
                    ctx={ctx}
                    submissions={submissions}
                    format={copyFormat}
                    fromJob={fromJob}
                  />
                </details>
              )}
            </>
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
                    {t('clusters.add')}
                  </button>
                )
              }
            />
          )}
          {visible.length > 0 && (
            <details className="panel-note plan-details">
              <summary>{t('plan.about')}</summary>
              <p>{t('plan.note')}</p>
              <WaitHistoryNote
                histories={visible.map((o) => data.wait_history?.[o.source.id])}
                relative
              />
            </details>
          )}
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
            format={copyFormat}
            fromJob={fromJob}
          />
        </details>
      )}
      {hasMachines && visibleMachines.length > 0 && (
        <Panel title={t('plan.machines')}>
          {unmatchedMachines > 0 && (
            <p className="panel-note">{t('plan.machinesNoMatch', { count: unmatchedMachines })}</p>
          )}
          {visibleMachines.length ? (
            <ul className="rows machine-options">
              {visibleMachines.map(({ instance, free, total, unknown, command }) => (
                <li key={instance.id} className={free < request.gpus ? 'muted' : undefined}>
                  <div className="grow">
                    <button className="link" onClick={() => ctx.openInstance(instance)}>
                      <strong>
                        {instance.platform} · {instance.name}
                      </strong>
                    </button>
                    <span className="sub">
                      {t('plan.machineFree', { free: unknown ? `≥ ${free}` : free, total })}
                    </span>
                    {unknown > 0 && (
                      <span className="sub">{t('plan.machineUnknown', { count: unknown })}</span>
                    )}
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
                        onClick={() =>
                          void ctx.copy(command, {
                            kind: 'command',
                            message: t('plan.machineCopied'),
                          })
                        }
                      >
                        {free < request.gpus
                          ? t('plan.machineCopyPartial', { count: free, requested: request.gpus })
                          : t('plan.machineCopy')}
                      </button>
                    )}
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
  format,
  fromJob,
}: {
  submissions: Map<string, ReturnType<typeof submitFlags>>;
  format: CopyFormat;
  fromJob?: Job;
  options: PlanOption[];
  request: PlanRequest;
  ctx: Ctx;
}) {
  // A chevron at the row's end, or the row itself, opens its explanation; no repeated text line.
  const [expanded, setExpanded] = useState<string[]>([]);
  const tableId = useId();
  const toggle = (key: string) =>
    setExpanded((keys) =>
      keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
    );
  return (
    <div className="table-wrap plan-options">
      <table className="table plan-table">
        <thead>
          <tr>
            <th>{t('job.cluster')}</th>
            <th className="col-high">{t('sources.col.login')}</th>
            <th>{t('job.qos')}</th>
            <th className="num">{t('plan.col.free')}</th>
            <th className="num col-low">{t('plan.col.perNode')}</th>
            <th className="num">{t('plan.col.limit')}</th>
            <th className="num col-mid">{t('plan.col.inUse')}</th>
            <th className="num">{t('plan.col.queued')}</th>
            <th className="num col-mid">{t('plan.col.wall')}</th>
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
            const verdict = shownVerdict(option);
            return (
              <Fragment key={option.key}>
                <tr className="plan-option-row clickable" onClick={() => toggle(option.key)}>
                  <td>
                    <span className="with-mark">
                      <strong>{option.source.name}</strong>
                      {jobWaitsHere(fromJob, option) && (
                        <span className="tag plan-qos">{t('plan.waitsHere')}</span>
                      )}
                    </span>
                  </td>
                  <td className="mono col-high" data-label={t('sources.col.login')}>
                    {option.source.username || '—'}
                  </td>
                  <td data-label={t('job.qos')}>{option.qos || '—'}</td>
                  <td className="num key" data-label={t('plan.col.free')}>
                    {freeGpuCount(option)}
                  </td>
                  <td className="num col-low" data-label={t('plan.col.perNode')}>
                    {option.largestNodeFree ?? '—'}
                  </td>
                  <td className="num" data-label={t('plan.col.limit')}>
                    {option.limit === Infinity ? t('plan.noLimit') : (option.limit ?? '—')}
                  </td>
                  <td className="num col-mid" data-label={t('plan.col.inUse')}>
                    {option.used ?? '—'}
                  </td>
                  <td className="num" data-label={t('plan.col.queued')}>
                    {option.queued ?? '—'}
                  </td>
                  <td className="num col-mid" data-label={t('plan.col.wall')}>
                    {option.maxWallHours == null ? '—' : duration(option.maxWallHours)}
                  </td>
                  <td className="plan-verdict">
                    <span className={`status ${TONES[verdict]}`}>
                      {verdict === 'behind' ? <Clock3 size={13} /> : <i />}
                      {verdictLabel(option, request)}
                    </span>
                    <SubmitCopy
                      result={submissions.get(option.key)!}
                      ctx={ctx}
                      option={option}
                      format={format}
                    />
                    <button
                      type="button"
                      className="icon-button plan-expand"
                      aria-expanded={expanded.includes(option.key)}
                      aria-controls={`${tableId}-${option.key}`}
                      aria-label={t('plan.explanationFor', { name: optionName(option) })}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(option.key);
                      }}
                    >
                      <ChevronDown size={16} />
                    </button>
                  </td>
                </tr>
                <tr
                  className="plan-explanation-row"
                  id={`${tableId}-${option.key}`}
                  hidden={!expanded.includes(option.key)}
                >
                  <td colSpan={10}>
                    <PlanExplanation option={option} request={request}>
                      {why && <p>{why}</p>}
                      {option.access === 'unknown' && (
                        <p>
                          {t('plan.accessNote', {
                            source: `${option.source.name} · ${option.source.username}`,
                          })}
                        </p>
                      )}
                      {reason && (
                        <p title={reason}>
                          {explanation && explanation.kind !== 'unknown'
                            ? t(`plan.queueReason.${explanation.kind}` as MessageKey)
                            : reason}
                        </p>
                      )}
                      {option.queuedForRoom != null ? (
                        <p>{t('plan.queuedGpus', { count: option.queuedForRoom })}</p>
                      ) : (
                        <p>{t('plan.queueRoomUnknown')}</p>
                      )}
                      <SubmitNotes result={submissions.get(option.key)} />
                      <WaitHistory
                        compact
                        history={ctx.data.wait_history?.[option.source.id]}
                        qos={option.qos}
                        gpus={request.gpus}
                      />
                      <ClockText>
                        {() =>
                          option.nodesObservedAt && (
                            <p className="sub">
                              {t('plan.nodesAt', { time: relativeTime(option.nodesObservedAt) })}
                            </p>
                          )
                        }
                      </ClockText>
                    </PlanExplanation>
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

function PlanExplanation({
  option,
  request,
  children,
}: {
  option: PlanOption;
  request: PlanRequest;
  children?: ReactNode;
}) {
  return (
    <div className="plan-explanation">
      {children}
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
    </div>
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
      <ClockText>
        {() =>
          t('plan.factor.source', {
            source: `${item.source.name} · ${item.source.username}`,
            capability: t(`plan.factor.capability.${item.capability}`),
            age: item.at ? relativeTime(item.at) : t('status.unknown'),
            state: t(item.current ? 'plan.factor.current' : 'plan.factor.notCurrent'),
          })
        }
      </ClockText>
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

type CopyFormat = { value: SubmitFormat; change: (value: SubmitFormat) => void };

/** Copy, with the flag format one menu away on the same control. */
function SubmitCopy({
  result,
  ctx,
  option,
  format,
}: {
  result: ReturnType<typeof submitFlags>;
  ctx: Ctx;
  option: PlanOption;
  format: CopyFormat;
}) {
  if (!result) return null;
  return (
    <div className="plan-submit split-button">
      <button
        className="button small"
        aria-label={t('plan.submit.copyFor', { name: optionName(option) })}
        onClick={(event) => {
          // A copy inside an option row must not also toggle the row's explanation.
          event.stopPropagation();
          void ctx.copy(result.text, { kind: 'command', message: t('plan.submit.copied') });
        }}
      >
        {t('plan.submit.copy')}
      </button>
      <span onClick={(event) => event.stopPropagation()}>
        <LazyMenuButton
          className="button small"
          aria-label={t('plan.submit.formatFor', { name: optionName(option) })}
          items={(['line', 'header'] as const).map((value) => ({
            id: value,
            label: t(`plan.submit.${value}`),
            role: 'menuitemradio' as const,
            checked: format.value === value,
            action: () => format.change(value),
          }))}
        >
          <ChevronDown size={14} />
        </LazyMenuButton>
      </span>
    </div>
  );
}

/** Flags the copied command could not confirm; read before pasting, so kept with the details. */
function SubmitNotes({ result }: { result: ReturnType<typeof submitFlags> | undefined }) {
  return result?.notes.map((note) => <p key={note}>{note}</p>);
}
