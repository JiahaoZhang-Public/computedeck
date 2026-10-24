import { PENDING_STATES, sourceHasData } from './domain';
import { t } from './i18n';
import { gpuModels } from './plan';
import type { PlanOption, PlanRequest } from './plan';
import type { ComputeNode, Dashboard, Job } from './types';

export type SubmitFormat = 'line' | 'header';

export function canCopySubmit(option: PlanOption) {
  return (
    option.source.driver === 'slurm' &&
    ['likely', 'possible', 'behind', 'busy'].includes(option.verdict) &&
    option.rule?.kind !== 'perJob'
  );
}

/** Use the option's QoS, current node model spelling, and this account's own jobs.
 * Nodes must already be deduplicated with uniqueNodes, shared across all options.
 */
export function submitFlags(
  option: PlanOption,
  request: PlanRequest,
  jobs: Job[],
  nodes: ComputeNode[],
  format: SubmitFormat,
) {
  if (!canCopySubmit(option)) return null;
  const own = jobs.filter(
    (job) =>
      job.cluster_id === option.source.cluster_id &&
      job.user === option.source.username &&
      job.qos === option.qos,
  );
  const flags: string[] = [];
  const notes: string[] = [];
  const unknownFlags: string[] = [];
  // Safe in shell arguments and #SBATCH directives alike; otherwise omit and explain.
  const token = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
  const only = (values: (string | null)[]) => {
    const known = [...new Set(values.filter((value) => value && token(value)))];
    return known.length === 1 && values.every((value) => !value || token(value)) ? known[0] : null;
  };
  const add = (flag: string, value: string | null) => {
    if (value) flags.push(`${flag} ${value}`);
    else unknownFlags.push(flag);
  };
  add('-q', option.qos && token(option.qos) ? option.qos : null);
  const currentNodes = nodes.filter(
    (node) =>
      node.cluster_id === option.source.cluster_id &&
      option.evidence.nodes.some((item) => item.source.id === node.source_id && item.current),
  );
  const matching = currentNodes.filter(
    (node) =>
      node.health === 'usable' &&
      (node.gpu_count == null || node.gpu_count > 0) &&
      (!request.gpuType ||
        node.gpu_type
          ?.toLowerCase()
          .split(',')
          .map((model) => model.trim())
          .includes(request.gpuType.toLowerCase())),
  );
  const ownPartition = only(own.map((job) => job.partition));
  const partition =
    ownPartition && matching.some((node) => node.partitions?.includes(ownPartition))
      ? ownPartition
      : null;
  add('-p', partition);
  add('-A', only(own.map((job) => job.account)));
  if (unknownFlags.length) notes.push(t('plan.submit.unknown', { flags: unknownFlags.join(', ') }));
  const model = only(
    currentNodes
      .flatMap((node) => node.gpu_type?.split(',').map((value) => value.trim()) ?? [])
      .filter((value) => value.toLowerCase() === request.gpuType.toLowerCase()),
  );
  if (request.gpuType && !model) notes.push(t('plan.submit.model'));
  let perNode = request.gpus;
  const partitionNodes = partition
    ? matching.filter((node) => node.partitions?.includes(partition))
    : matching;
  const sizes = partitionNodes.map((node) =>
    request.gpuType && node.gpu_type?.includes(',') ? null : node.gpu_count,
  );
  const size = sizes[0];
  if (
    size &&
    sizes.every((count) => count === size) &&
    request.gpus > size &&
    request.gpus % size === 0
  ) {
    flags.push(`--nodes=${request.gpus / size}`);
    perNode = size;
  } else if (sizes.length && sizes.every((count) => count != null && count < request.gpus)) {
    notes.push(t('plan.submit.multiNode'));
  }
  flags.push(`--gres=gpu${request.gpuType && model ? `:${model}` : ''}:${perNode}`);
  if (request.hours != null && request.hours > 0) {
    // Keep a positive sub-minute request from becoming Slurm's unlimited zero.
    const minutes = Math.max(1, Math.round(request.hours * 60));
    const days = Math.floor(minutes / 1440);
    const hh = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    flags.push(`-t ${days}-${hh}:${mm}:00`);
  } else if (request.hours === 0) notes.push(t('plan.submit.zeroTime'));
  return {
    text: format === 'header' ? flags.map((flag) => `#SBATCH ${flag}`).join('\n') : flags.join(' '),
    notes,
  };
}

export function jobPlanRequest(job: Job, nodes: ComputeNode[]): PlanRequest {
  const model = job.gpu_type;
  return {
    gpus: job.gpu_count != null && job.gpu_count >= 1 && job.gpu_count <= 1024 ? job.gpu_count : 1,
    gpuType: model && !model.includes(',') && gpuModels(nodes).includes(model) ? model : '',
    hours: null,
  };
}

export function jobPlanLink(job: Job, nodes: ComputeNode[]) {
  const request = jobPlanRequest(job, nodes);
  const params = new URLSearchParams({ from: job.id, gpus: String(request.gpus) });
  if (request.gpuType) params.set('model', request.gpuType);
  return `#/plan?${params}`;
}

export function planPresets(data: Dashboard) {
  const seen = new Set<string>();
  const failures = new Set<Job>(data.recent_failures ?? []);
  const recentTime = (job: Job) =>
    (failures.has(job)
      ? Date.parse(job.ended_at ?? '') || Date.parse(job.end ?? '')
      : Date.parse(job.submitted_at ?? '')) ||
    Date.parse(job.observed_at ?? '') ||
    0;
  return [
    ...data.jobs.filter((job) =>
      data.sources.some((source) => source.id === job.source_id && sourceHasData(source, 'jobs')),
    ),
    ...(data.recent_failures ?? []),
  ]
    .filter(
      (job) =>
        job.gpu_count != null &&
        job.gpu_count > 0 &&
        job.gpu_count <= 1024 &&
        data.sources.some((source) => source.id === job.source_id && source.username === job.user),
    )
    .sort((a, b) => recentTime(b) - recentTime(a))
    .filter((job) => {
      const request = jobPlanRequest(job, data.nodes);
      const key = `${request.gpus}:${request.gpuType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

export function jobWaitsHere(job: Job | undefined, option: PlanOption) {
  return (
    !!job &&
    PENDING_STATES.includes(job.state.toUpperCase()) &&
    job.cluster_id === option.source.cluster_id &&
    job.user === option.source.username &&
    job.qos === option.qos
  );
}
