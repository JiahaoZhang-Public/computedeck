import { relativeTime } from './domain';
import { t, type MessageKey } from './i18n';
import {
  comparePlans,
  type PlanObservation,
  type PlanOption,
  type PlanRequest,
  type QosRule,
} from './plan';

export const RULES: Record<QosRule['kind'], Partial<Record<QosRule['effect'], MessageKey>>> = {
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

type Effect = 'supports' | 'lowers' | 'unknown' | 'neutral' | 'ranking';
export interface PlanFactor {
  key: 'free' | 'oneNode' | 'limit' | 'queue' | 'wall' | 'access' | 'age';
  value: string;
  effect: Effect;
  evidence: PlanObservation[];
}

const number = (value: number | null) =>
  value == null ? t('status.unknown') : value === Infinity ? t('plan.noLimit') : String(value);
const enough = (value: number | null, request: number): Effect =>
  value == null ? 'unknown' : value >= request ? 'supports' : 'lowers';

export function planFactors(option: PlanOption, request: PlanRequest): PlanFactor[] {
  const { evidence } = option;
  const all = [...evidence.nodes, ...evidence.limits, ...evidence.jobs, ...evidence.access];
  const knownAge = all.every((item) => item.at != null);
  const current = all.every((item) => item.current);
  const age = knownAge ? all.map((item) => item.at!).sort()[0] : null;
  const rules = option.rules
    .map((rule) => {
      const key = RULES[rule.kind][rule.effect];
      return key ? t(key, { count: rule.limit, limit: rule.limit, used: rule.used }) : '';
    })
    .join(' ');
  return [
    {
      key: 'free',
      value: `${t('plan.factor.freeValue', { count: `${option.freeGpusPartial && option.freeGpus != null ? '≥ ' : ''}${number(option.freeGpus)}` })} ${option.onDemandGpus ? t('plan.why.onDemand', { count: option.onDemandGpus }) : ''}`,
      effect: enough(option.freeGpus, request.gpus),
      evidence: evidence.nodes,
    },
    {
      key: 'oneNode',
      value: t('plan.factor.oneNodeValue', {
        count: number(option.largestNodeFree),
        fit:
          option.largestNodeFree == null
            ? t('status.unknown')
            : t(
                option.largestNodeFree >= request.gpus
                  ? 'plan.compare.fits'
                  : 'plan.compare.notFit',
              ),
        requested: request.gpus,
      }),
      // Node fit is a tie-breaker only; it never changes the verdict.
      effect: option.largestNodeFree == null ? 'unknown' : 'ranking',
      evidence: evidence.nodes,
    },
    {
      key: 'limit',
      value: `${t('plan.factor.limitValue', { limit: number(option.limit), used: number(option.used), room: number(option.headroom) })} ${rules}`,
      effect: option.rules.some((rule) => rule.effect !== 'doubt')
        ? 'lowers'
        : option.rules.length
          ? 'unknown'
          : enough(option.headroom, request.gpus),
      evidence: [...evidence.limits, ...evidence.jobs],
    },
    {
      key: 'queue',
      value: `${t('plan.factor.queueValue', { jobs: number(option.queued), used: number(option.queuedForRoom), room: number(option.headroomAfterQueue) })}${option.contradiction ? ` ${t('plan.why.contradiction', option.contradiction)}` : ''}`,
      effect: option.contradiction ? 'lowers' : enough(option.headroomAfterQueue, request.gpus),
      evidence: [...evidence.jobs, ...evidence.limits],
    },
    {
      key: 'wall',
      value: `${t('plan.factor.wallValue', { max: number(option.maxWallHours), requested: request.hours == null ? t('plan.factor.notEntered') : number(request.hours) })}${request.hours == null || option.maxWallHours == null ? ` ${t('plan.factor.wallUnchecked')}` : ''}`,
      effect:
        request.hours == null || option.maxWallHours == null
          ? 'neutral'
          : enough(option.maxWallHours, request.hours),
      evidence: evidence.limits,
    },
    {
      key: 'access',
      value: t(`plan.factor.access.${option.access}`),
      effect: option.access === 'verified' ? 'supports' : 'lowers',
      evidence: evidence.access,
    },
    {
      key: 'age',
      value: t('plan.factor.ageValue', {
        age: age ? relativeTime(age) : t('status.unknown'),
        state: t(current ? 'plan.factor.current' : 'plan.factor.notCurrent'),
      }),
      effect: current ? 'neutral' : 'lowers',
      evidence: all,
    },
  ];
}

/** The explanation follows the comparator, including an honest tie. */
export function planComparison(best: PlanOption, next: PlanOption, request: PlanRequest) {
  const { factor } = comparePlans(best, next, request);
  const value = (option: PlanOption) => {
    switch (factor) {
      case 'verdict':
        return option.verdict === 'none'
          ? t(request.gpuType ? 'plan.verdict.none' : 'plan.verdict.noGpus', {
              model: request.gpuType,
            })
          : t(`plan.verdict.${option.verdict}`);
      case 'oneNode':
        return option.largestNodeFree == null
          ? t('status.unknown')
          : t(option.largestNodeFree >= request.gpus ? 'plan.compare.fits' : 'plan.compare.notFit');
      case 'queue':
        return number(option.headroomAfterQueue);
      case 'free':
        return `${option.freeGpusPartial && option.freeGpus != null ? '≥ ' : ''}${number(option.freeGpus)}`;
      case 'access':
        return t(`plan.factor.access.${option.access}`);
      case 'tie':
        return '';
    }
  };
  const other = `${next.source.name} · ${next.source.username}${next.qos ? ` · ${next.qos}` : ''}`;
  return factor === 'tie'
    ? t('plan.compare.tie', { other })
    : t('plan.compare.reason', {
        other,
        factor: t(`plan.compare.${factor}`),
        best: value(best),
        next: value(next),
      });
}
