import type { ComputeNode, Dashboard, Instance, Job, QosLimit, Source } from './types';
import { directSSHCommand } from './connections';
import { reasonCode, reasonKind } from './jobFacts';
import {
  freeGpuIndexes,
  gpuMatchesModel,
  holdsAllocation,
  PENDING_STATES,
  instanceLifecycle,
  gpuTres,
  qosGpuLimit,
  qosGpuUsed,
  qosUsedTres,
  sourceHasData,
  uniqueNodes,
} from './domain';

/** What the user wants to run. */
export interface PlanRequest {
  gpus: number;
  /** Case-insensitive exact GPU model, or '' for any model. */
  gpuType: string;
  /** Expected run time, or null when unknown. */
  hours: number | null;
}

/**
 * - likely: enough visible free GPUs, known QoS headroom, and no QoS rule left unchecked.
 * - possible: free GPUs, but the QoS limit is unknown (or the other way round), or a QoS
 *   rule could not be checked. A personal-limit wait that fits the collected room
 *   also caps likely at possible.
 * - behind: your eligible queued GPUs leave too little headroom (an estimate, not FIFO).
 * - busy: not enough visible free GPUs right now, or the QoS's shared GPUs are taken.
 * - limit: your QoS limit is used up, or the request breaks a QoS rule.
 * - wall: the run is longer than the QoS allows.
 * - unknown: no node data and no limit.
 * - none: the collected nodes have no GPUs of the requested model at all.
 */
export type Verdict =
  | 'likely'
  | 'possible'
  | 'behind'
  | 'busy'
  | 'limit'
  | 'wall'
  | 'unknown'
  | 'none'
  | 'unavailable'
  | 'denied';

/**
 * A QoS rule other than the per-user GPU limit that decides an estimate.
 * - perJob: MaxTRESPJ, the most GPUs one job may have.
 * - jobs: MaxJobsPU, how many of your jobs may run at once.
 * - submit: MaxSubmitJobsPU, how many of your jobs may run or wait.
 * - group: GrpTRES, the GPUs all users of the QoS share.
 * - typed: a per-model cap that may apply while no model is chosen.
 */
export interface QosRule {
  kind: 'perJob' | 'jobs' | 'submit' | 'group' | 'typed';
  limit: number;
  /** Jobs or GPUs counted against the limit; null when unknown. */
  used: number | null;
  /** limit: the request cannot start; busy: it would wait; doubt: it could not be checked. */
  effect: 'limit' | 'busy' | 'doubt';
}

export interface PlanOption {
  /** The actual logins and observation times used by each part of the estimate. */
  evidence: Record<'nodes' | 'limits' | 'jobs' | 'access', PlanObservation[]>;
  access: 'verified' | 'not_associated' | 'unknown';
  key: string;
  source: Source;
  qos: string | null;
  /** Unallocated GPUs of the requested model on healthy visible nodes. */
  freeGpus: number | null;
  /** On-demand GPUs of the requested model; null when the count or model is unknown. */
  onDemandGpus: number | null;
  /** Free GPUs are a lower bound because matching capacity is partly unmeasured. */
  freeGpusPartial: boolean;
  /** The most free GPUs of that model on one node; fewer than requested means multi-node. */
  largestNodeFree: number | null;
  matchingNodes: number;
  limit: number | null;
  used: number | null;
  headroom: number | null;
  /** Eligible queued jobs; null when the login's job list is not current. */
  queued: number | null;
  queuedGpus: number | null;
  /** Reduction in available headroom from the queue, across the applicable GPU caps. */
  queuedForRoom: number | null;
  headroomAfterQueue: number | null;
  reasons: string[] | null;
  /** A personal-limit wait that disagrees with the collected GPU or job-count room. */
  contradiction: { job: string; reason: string } | null;
  maxWallHours: number | null;
  nodesObservedAt: string | null;
  /** The collected nodes are complete enough to say none has a GPU of the requested model. */
  noMatchingGpus: boolean;
  /** QoS rules other than the per-user GPU limit that bind or could not be checked. */
  rules: QosRule[];
  verdict: Verdict;
  /** The rule behind the verdict, when one is. */
  rule: QosRule | null;
}

export interface PlanObservation {
  source: Source;
  capability: 'nodes' | 'qos_limits' | 'jobs' | 'qos_access';
  at: string | null;
  current: boolean;
}

function observations(
  sources: Source[],
  capability: PlanObservation['capability'],
  rows?: { source_id: string; observed_at: string | null }[],
): PlanObservation[] {
  return sources.map((source) => {
    const times = rows?.filter((row) => row.source_id === source.id).map((row) => row.observed_at);
    return {
      source,
      capability,
      at: times?.length ? (times.some((at) => !at) ? null : times.sort()[0]) : source.last_success,
      current: sourceHasData(source, capability),
    };
  });
}

const ORDER: Verdict[] = [
  'likely',
  'possible',
  'behind',
  'busy',
  'limit',
  'wall',
  'unknown',
  'none',
  'unavailable',
  'denied',
];

/** Slurm walltime: minutes ("2880"), or [D-]HH:MM:SS ("1-00:00:00"). */
export function wallHours(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) / 60;
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/.exec(value);
  if (!match) return null;
  const [, days = '0', hours, minutes, seconds = '0'] = match;
  return Number(days) * 24 + Number(hours) + Number(minutes) / 60 + Number(seconds) / 3600;
}

function models(value: string | null | undefined) {
  return (value ?? '')
    .toLowerCase()
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function matchesModel(node: ComputeNode, gpuType: string) {
  if (!gpuType) return true;
  return models(node.gpu_type).includes(gpuType.toLowerCase());
}

function capacity(nodes: ComputeNode[], gpuType: string, requestedGpus: number) {
  // Nodes that may hold GPUs: one with an unknown count might.
  const gpuNodes = nodes.filter((node) => node.gpu_count == null || node.gpu_count > 0);
  const matching = gpuNodes.filter((node) => matchesModel(node, gpuType));
  const usable = matching.filter(
    (node) => node.health === 'usable' && node.gpu_count != null && node.gpu_count > 0,
  );
  const free = usable.map((node) =>
    node.gpu_allocated == null || (gpuType && models(node.gpu_type).length > 1)
      ? null
      : Math.max(0, (node.gpu_count ?? 0) - node.gpu_allocated),
  );
  const known = free.filter((value): value is number => value != null);
  // Every collected node says how many GPUs it has and, for a chosen model, which model:
  // then a cluster without usable matching nodes has none free, rather than unknown.
  const complete =
    nodes.length > 0 &&
    gpuNodes.every(
      (node) =>
        node.health !== 'unknown' &&
        node.health != null &&
        node.gpu_count != null &&
        (!gpuType || !!node.gpu_type),
    );
  const onDemand = gpuNodes.filter((node) => node.health === 'on_demand');
  const onDemandUnknown = onDemand.some(
    (node) =>
      (matchesModel(node, gpuType) && node.gpu_count == null) ||
      (gpuType &&
        (!node.gpu_type || (matchesModel(node, gpuType) && models(node.gpu_type).length > 1))),
  );
  const knownFree = known.reduce((a, b) => a + b, 0);
  const partial =
    known.length < free.length ||
    matching.some(
      (node) =>
        node.health !== 'unavailable' &&
        node.health !== 'on_demand' &&
        (node.health !== 'usable' || node.gpu_count == null || node.gpu_allocated == null),
    );
  return {
    matchingNodes: usable.length,
    onDemandGpus:
      !nodes.length || onDemandUnknown
        ? null
        : onDemand
            .filter((node) => matchesModel(node, gpuType))
            .reduce((sum, node) => sum + (node.gpu_count ?? 0), 0),
    freeGpus: partial
      ? knownFree >= requestedGpus
        ? knownFree
        : null
      : usable.length || complete
        ? knownFree
        : null,
    freeGpusPartial: partial,
    largestNodeFree: known.length ? Math.max(...known) : null,
    noMatchingGpus: complete && !matching.length,
    observedAt:
      (usable.length ? usable : nodes)
        .map((node) => node.observed_at)
        .filter((at): at is string => !!at)
        .sort()[0] ?? null,
  };
}

/** A job count limit such as MaxJobsPU; null when absent or "N" (no limit). */
function countLimit(value: string | null | undefined): number | null {
  return value && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

/** Finite GPU entries of a TRES list that bind a request for `model` ('' for any model). */
function binding(tres: string | null | undefined, model: string) {
  return gpuTres(tres).filter(
    (entry) => Number.isFinite(entry.value) && (!entry.model || entry.model === model),
  );
}

/** Finite per-model entries that may bind a request for no particular model. */
function typedCaps(tres: string | null | undefined, model: string) {
  return model ? [] : gpuTres(tres).filter((entry) => entry.model && Number.isFinite(entry.value));
}

// These jobs cannot compete for resources yet. Limit waits count only if they fit
// the current room; this is an estimate, not a queue position.
const QUEUE_BLOCKED = new Set([
  'Held', // PBS and LSF holds.
  'JobHeldUser',
  'JobHeldAdmin',
  'JobHoldMaxRequeue',
  'Dependency',
  'DependencyNeverSatisfied',
  'BeginTime',
  'JobArrayTaskLimit',
]);

function queuedGpus(jobs: Job[], model = '', headroom: number | null = null): number | null {
  if (headroom === Infinity) return 0;
  let total = 0;
  // Listed order is an estimate, not scheduler priority. Skip jobs that no longer fit.
  for (const job of jobs) {
    if (job.gpu_count === 0) continue;
    if (model && job.gpu_type && !models(job.gpu_type).includes(model)) continue;
    const remaining = headroom == null ? null : headroom - total;
    if (remaining === 0) break;
    if (remaining != null && job.gpu_count != null && job.gpu_count > remaining) continue;
    if (job.gpu_count == null || (model && models(job.gpu_type).length !== 1)) return null;
    total += job.gpu_count;
  }
  return total;
}

/**
 * QoS rules besides the per-user GPU limit. `jobs` are this login's jobs in the QoS, or null
 * when its job list is not current; `usage` is what the scheduler reported, empty when it
 * reported nothing or is not current.
 */
function qosRules(
  qos: QosLimit,
  request: PlanRequest,
  jobs: { running: Job[]; queued: Job[] } | null,
  usage: Record<string, string>,
): QosRule[] {
  const model = request.gpuType.toLowerCase();
  const rules: QosRule[] = [];
  const perJob = binding(qos.limits?.MaxTRESPJ, model);
  if (perJob.length) {
    const limit = Math.min(...perJob.map((entry) => entry.value));
    if (request.gpus > limit) rules.push({ kind: 'perJob', limit, used: null, effect: 'limit' });
  }
  for (const entry of typedCaps(qos.limits?.MaxTRESPJ, model))
    if (request.gpus > entry.value)
      rules.push({ kind: 'typed', limit: entry.value, used: null, effect: 'doubt' });
  const counted = [
    { kind: 'jobs' as const, key: 'MaxJobsPU', jobs: jobs?.running },
    {
      kind: 'submit' as const,
      key: 'MaxSubmitJobsPU',
      jobs: jobs && [...jobs.running, ...jobs.queued],
    },
  ];
  for (const { kind, key, jobs: mine } of counted) {
    const limit = countLimit(qos.limits?.[key]);
    if (limit == null) continue;
    // The scheduler's own count is believed over the jobs this login lists.
    const used = countLimit(usage[key]) ?? mine?.length ?? null;
    if (used != null && used >= limit) rules.push({ kind, limit, used, effect: 'limit' });
  }
  const shared = gpuTres(usage.GrpTRES);
  // The whole QoS's use of one GPU entry ('' for the total).
  const sharedUse = (gpuModel: string) =>
    shared.find((entry) => entry.model === gpuModel)?.value ?? null;
  for (const entry of binding(qos.limits?.GrpTRES, model)) {
    const used = sharedUse(entry.model);
    const rule = { kind: 'group' as const, limit: entry.value, used };
    if (request.gpus > entry.value) rules.push({ ...rule, effect: 'limit' });
    else if (used == null) rules.push({ ...rule, effect: 'doubt' });
    else if (request.gpus > entry.value - used) rules.push({ ...rule, effect: 'busy' });
  }
  for (const entry of typedCaps(qos.limits?.GrpTRES, model)) {
    const used = sharedUse(entry.model);
    if (used == null || request.gpus > entry.value - used)
      rules.push({ kind: 'typed', limit: entry.value, used, effect: 'doubt' });
  }
  return rules;
}

function verdict(
  option: Omit<PlanOption, 'verdict' | 'key' | 'rule'>,
  request: PlanRequest,
): { verdict: Verdict; rule: QosRule | null } {
  const rule = (effect: QosRule['effect']) =>
    option.rules.find((item) => item.effect === effect) ?? null;
  if (option.access === 'not_associated') return { verdict: 'denied', rule: null };
  if (sourceHasData(option.source, 'nodes') && option.source.cluster_state === 'unavailable')
    return { verdict: 'unavailable', rule: null };
  if (option.noMatchingGpus) return { verdict: 'none', rule: null };
  if (request.hours != null && option.maxWallHours != null && request.hours > option.maxWallHours)
    return { verdict: 'wall', rule: null };
  if (option.headroom != null && option.headroom < request.gpus)
    return { verdict: 'limit', rule: null };
  if (rule('limit')) return { verdict: 'limit', rule: rule('limit') };
  if (option.freeGpus != null && option.freeGpus < request.gpus)
    return { verdict: 'busy', rule: null };
  if (rule('busy')) return { verdict: 'busy', rule: rule('busy') };
  if (option.headroomAfterQueue != null && option.headroomAfterQueue < request.gpus)
    return { verdict: 'behind', rule: null };
  // A rule or queue that could not be checked keeps the estimate at "possible".
  if (option.freeGpus != null && option.headroom != null)
    return option.access !== 'verified' ||
      option.queuedForRoom == null ||
      option.headroomAfterQueue == null ||
      option.source.cluster_state === 'degraded' ||
      option.contradiction != null ||
      rule('doubt')
      ? { verdict: 'possible', rule: rule('doubt') }
      : { verdict: 'likely', rule: null };
  if (option.freeGpus != null || option.headroom != null)
    return { verdict: 'possible', rule: null };
  return { verdict: 'unknown', rule: null };
}

/** One option per cluster login and QoS, best first. Estimates only; the scheduler decides. */
export function planOptions(
  data: Pick<Dashboard, 'sources' | 'nodes' | 'jobs'>,
  request: PlanRequest,
): PlanOption[] {
  const nodes = uniqueNodes(
    data.nodes.filter((node) =>
      data.sources.some((source) => source.id === node.source_id && sourceHasData(source, 'nodes')),
    ),
  );
  const sources = data.sources
    .filter((source) => source.kind === 'cluster' && source.enabled)
    .sort(
      (a, b) =>
        Number(sourceHasData(b, 'qos_limits')) - Number(sourceHasData(a, 'qos_limits')) ||
        Number(sourceHasData(b, 'jobs')) - Number(sourceHasData(a, 'jobs')) ||
        (Date.parse(b.last_success ?? '') || 0) - (Date.parse(a.last_success ?? '') || 0),
    );
  const seen = new Set<string>();
  const options: PlanOption[] = [];
  for (const source of sources) {
    // An uncollected twin must not add a "no QoS" row beside this login's QoS rows.
    if (
      !source.qos.length &&
      sources.some(
        (other) =>
          other.cluster_id === source.cluster_id &&
          other.username === source.username &&
          other.qos.length > 0,
      )
    )
      continue;
    const clusterNodes = nodes.filter((node) => node.cluster_id === source.cluster_id);
    const nodeObservations = observations(
      clusterNodes.length
        ? sources.filter((login) => clusterNodes.some((node) => node.source_id === login.id))
        : [source],
      'nodes',
      clusterNodes,
    );
    const cluster = capacity(clusterNodes, request.gpuType, request.gpus);
    const twins = new Set(
      sources
        .filter(
          (other) =>
            other.cluster_id === source.cluster_id &&
            other.username === source.username &&
            sourceHasData(other, 'jobs'),
        )
        .map((other) => other.id),
    );
    // Jobs may retain either twin's source_id after dashboard deduplication.
    // Keep the newest observation of each job, preferring this source on a tie.
    const mine = new Map<string, Job>();
    for (const job of data.jobs) {
      if (!twins.has(job.source_id) || job.cluster_id !== source.cluster_id) continue;
      const previous = mine.get(job.id);
      const age =
        (Date.parse(job.observed_at ?? '') || 0) - (Date.parse(previous?.observed_at ?? '') || 0);
      if (!previous || age > 0 || (age === 0 && job.source_id === source.id)) mine.set(job.id, job);
    }
    const currentJobs = twins.size > 0;
    const qosList: (QosLimit | null)[] = source.qos.length ? source.qos : [null];
    for (const qos of qosList) {
      const key = JSON.stringify([source.cluster_id, source.username, qos?.name ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      const currentQos = sourceHasData(source, 'qos_limits') ? qos : null;
      const inQos = [...mine.values()].filter((job) => !qos || job.qos === qos.name);
      const running = inQos.filter(holdsAllocation);
      const pending = inQos.filter((job) => PENDING_STATES.includes(job.state.toUpperCase()));
      const eligible = pending.filter((job) => !QUEUE_BLOCKED.has(job.reason ?? ''));
      const queued = currentJobs ? queuedGpus(eligible) : null;
      let limit = currentQos ? qosGpuLimit(currentQos, request.gpuType) : null;
      // A scheduler that reports usage against the limit (Slurm's assoc_mgr, a Kubernetes
      // quota) is believed over a sum of jobs, whose QoS field may name something else.
      const reported = currentQos ? qosGpuUsed(currentQos) : null;
      let used = !currentJobs
        ? null
        : (reported ??
          (running.some((job) => job.gpu_count == null)
            ? null
            : running.reduce((sum, job) => sum + (job.gpu_count ?? 0), 0)));
      let headroom = limit != null && used != null ? Math.max(0, limit - used) : null;
      // Kubernetes quota usage already includes admitted pending pods.
      const includesPending = currentQos?.origin === 'kubernetes_resource_quota';
      let queuedForRoom = !currentJobs
        ? null
        : includesPending
          ? 0
          : queuedGpus(eligible, '', headroom);
      let headroomAfterQueue =
        headroom != null && queuedForRoom != null ? headroom - queuedForRoom : null;
      if (currentQos && request.gpuType && currentJobs) {
        const constraints = gpuTres(currentQos.limits?.MaxTRESPU).filter(
          (entry) => !entry.model || entry.model === request.gpuType.toLowerCase(),
        );
        const reportedUsage = gpuTres(qosUsedTres(currentQos));
        const rooms = constraints.map((entry) => {
          const relevant = running.filter(
            (job) =>
              job.gpu_count !== 0 &&
              (!entry.model || !job.gpu_type || models(job.gpu_type).includes(entry.model)),
          );
          const measured = reportedUsage.find((value) => value.model === entry.model)?.value;
          const count =
            measured ??
            (relevant.some(
              (job) => job.gpu_count == null || (entry.model && models(job.gpu_type).length !== 1),
            )
              ? null
              : relevant.reduce((sum, job) => sum + (job.gpu_count ?? 0), 0));
          const room = count == null ? null : Math.max(0, entry.value - count);
          const waiting = includesPending ? 0 : queuedGpus(eligible, entry.model, room);
          return {
            afterQueue: room == null || waiting == null ? null : room - waiting,
            limit: entry.value,
            used: count,
            headroom: room,
          };
        });
        const tightest = rooms
          .filter((room) => room.headroom != null)
          .sort((a, b) => a.headroom! - b.headroom!)[0];
        if (tightest) {
          limit = tightest.limit;
          used = tightest.used;
        }
        headroom = rooms.some((room) => room.headroom == null)
          ? null
          : (tightest?.headroom ?? headroom);
        if (rooms.length) {
          headroomAfterQueue = rooms.some((room) => room.afterQueue == null)
            ? null
            : Math.min(...rooms.map((room) => room.afterQueue!));
          // Different caps can bind before and after the queue. Report the reduction
          // in available room so the displayed arithmetic still adds up.
          queuedForRoom =
            headroom === Infinity
              ? 0
              : headroom != null &&
                  headroomAfterQueue != null &&
                  Number.isFinite(headroom) &&
                  Number.isFinite(headroomAfterQueue)
                ? headroom - headroomAfterQueue
                : headroomAfterQueue == null
                  ? null
                  : queuedForRoom;
        }
      }
      // Without a model choice, a finite typed cap may still reject the request.
      if (
        !request.gpuType &&
        currentQos &&
        gpuTres(currentQos.limits?.MaxTRESPU).some(
          (entry) => entry.model && Number.isFinite(entry.value),
        )
      ) {
        headroom = null;
        headroomAfterQueue = null;
        queuedForRoom = null;
      }
      const rules = currentQos
        ? qosRules(
            currentQos,
            request,
            currentJobs ? { running, queued: pending } : null,
            currentQos.usage ?? {},
          )
        : [];
      const hasTypedCap =
        currentQos &&
        gpuTres(currentQos.limits?.MaxTRESPU).some(
          (entry) => entry.model && Number.isFinite(entry.value),
        );
      const contradictory =
        currentJobs &&
        !includesPending &&
        headroom != null &&
        !rules.some((rule) => ['jobs', 'submit'].includes(rule.kind) && rule.effect === 'limit')
          ? eligible.find((job) => {
              const reason = reasonCode(job.reason);
              if (
                job.gpu_count == null ||
                job.gpu_count > headroom! ||
                reasonKind(reason, source.driver) !== 'personalLimit'
              )
                return false;
              if (reason === 'QOSMaxGRESPerUser')
                // Only the requested model's room was checked, including other typed caps.
                return (
                  job.gpu_count > 0 &&
                  (!hasTypedCap ||
                    (models(job.gpu_type).length === 1 &&
                      models(job.gpu_type).includes(request.gpuType.toLowerCase())))
                );
              // Count waits can reflect uncollected association or partition QoS limits.
              // CPU room is not evaluated.
              return [
                'QOSMaxJobsPerUserLimit',
                'AssocMaxJobsLimit',
                'QOSMaxSubmitJobPerUserLimit',
                'AssocMaxSubmitJobLimit',
              ].includes(reason);
            })
          : undefined;
      const option = {
        source,
        evidence: {
          nodes: nodeObservations,
          limits: observations([source], 'qos_limits'),
          jobs: observations(
            currentJobs ? sources.filter((login) => twins.has(login.id)) : [source],
            'jobs',
            inQos,
          ),
          access: observations([source], 'qos_access'),
        },
        access: sourceHasData(source, 'qos_access')
          ? (qos?.access ?? 'unknown')
          : ('unknown' as const),
        qos: qos?.name ?? null,
        freeGpus: cluster.freeGpus,
        onDemandGpus: cluster.onDemandGpus,
        freeGpusPartial: cluster.freeGpusPartial,
        largestNodeFree: cluster.largestNodeFree,
        matchingNodes: cluster.matchingNodes,
        limit,
        used,
        headroom,
        queued: currentJobs ? eligible.length : null,
        queuedGpus: queued,
        queuedForRoom,
        headroomAfterQueue,
        reasons: currentJobs
          ? [...new Set(eligible.map((job) => job.reason).filter((r): r is string => !!r))]
          : null,
        maxWallHours: currentQos ? wallHours(currentQos.limits?.MaxWallPJ) : null,
        contradiction: contradictory
          ? { job: contradictory.name || contradictory.id, reason: contradictory.reason! }
          : null,
        nodesObservedAt: cluster.observedAt,
        noMatchingGpus: cluster.noMatchingGpus,
        rules,
      };
      options.push({
        ...option,
        key: `${source.id}:${option.qos ?? ''}`,
        ...verdict(option, request),
      });
    }
  }
  return options.sort((a, b) => comparePlans(a, b, request).order);
}

/** Sorting and its explanation share the same first differing factor. */
export function comparePlans(a: PlanOption, b: PlanOption, request: PlanRequest) {
  const factors = [
    ['verdict', -ORDER.indexOf(a.verdict), -ORDER.indexOf(b.verdict)],
    [
      'oneNode',
      Number((a.largestNodeFree ?? 0) >= request.gpus),
      Number((b.largestNodeFree ?? 0) >= request.gpus),
    ],
    ['queue', a.headroomAfterQueue ?? -Infinity, b.headroomAfterQueue ?? -Infinity],
    ['free', a.freeGpus ?? -1, b.freeGpus ?? -1],
    ['access', Number(a.access === 'verified'), Number(b.access === 'verified')],
  ] as const;
  for (const [factor, left, right] of factors)
    if (left !== right) return { factor, order: left > right ? -1 : 1 };
  return { factor: 'tie' as const, order: a.key.localeCompare(b.key) };
}

/** Models reported by scheduler nodes and per-GPU machine rows. */
export function gpuModels(nodes: ComputeNode[], instances: Instance[] = []) {
  return [
    ...new Set(
      [
        ...nodes.flatMap((node) =>
          node.gpu_type ? node.gpu_type.split(',').map((model) => model.trim()) : [],
        ),
        ...instances.flatMap((item) =>
          (item.gpus ?? []).flatMap((gpu) => (gpu.name ? [gpu.name] : [])),
        ),
      ].filter(Boolean),
    ),
  ].sort();
}

/** Cloud instances you already pay for that are almost idle; not machines added by hand. */
export function idleInstances(instances: Instance[], threshold = 10) {
  return instances.filter(
    (item) =>
      !item.manual &&
      item.metrics_scope !== 'host_visible' &&
      instanceLifecycle(item.state) === 'held' &&
      item.gpu_utilization != null &&
      item.gpu_utilization < threshold &&
      (item.gpu_count ?? 0) > 0,
  );
}

/** Separate current GPU samples from otherwise eligible machines missing a recent sample. */
export function machineSamples(data: Pick<Dashboard, 'sources' | 'instances'>, now = Date.now()) {
  let staleCount = 0;
  const current = data.instances.flatMap((instance) => {
    const source = data.sources.find((source) => source.id === instance.source_id);
    if (
      !source ||
      source.driver !== 'ssh' ||
      instance.state !== 'running' ||
      !sourceHasData(source, 'instances')
    )
      return [];
    const age = Math.max(0, now - Date.parse(instance.gpus_observed_at ?? ''));
    if (!Number.isFinite(age) || age > source.interval_minutes * 120000) {
      staleCount += 1;
      return [];
    }
    if (!instance.gpus?.length) return [];
    return [{ instance, source }];
  });
  return { current, staleCount };
}

/** Current per-GPU SSH samples, separate from scheduler estimates. */
export function machineOptions(
  data: Pick<Dashboard, 'sources' | 'instances'>,
  request: PlanRequest,
  now = Date.now(),
) {
  return machineSamples(data, now)
    .current.map(({ instance, source }) => {
      const gpus = instance.gpus!;
      const matching = gpus.filter((gpu) => gpuMatchesModel(gpu, request.gpuType));
      const unknown =
        matching.filter((gpu) => gpu.in_use == null).length +
        (request.gpuType ? gpus.filter((gpu) => !gpu.name).length : 0);
      const free = matching.filter((gpu) => gpu.in_use === false).length;
      const indexes = freeGpuIndexes(instance, request.gpuType)
        .sort((a, b) => a - b)
        .slice(0, request.gpus);
      const ssh = directSSHCommand(instance);
      // Only the NVIDIA query provides gpu_processes; GPU names can also start with Tesla.
      const nvidia = indexes.length > 0 && source.capabilities.includes('gpu_processes');
      return {
        instance,
        source,
        free,
        total: matching.length,
        unknown,
        command:
          ssh && nvidia
            ? `${ssh.replace(/^ssh /, 'ssh -t ')} 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=${indexes.join(',')}; exec "\${SHELL:-sh}" -l'`
            : null,
      };
    })
    .sort((a, b) => b.free - a.free || a.instance.name.localeCompare(b.instance.name));
}
