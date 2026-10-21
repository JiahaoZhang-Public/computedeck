import type { Message } from './i18n';

export type Kind = 'cluster' | 'cloud';
export interface QosLimit {
  access?: 'verified' | 'not_associated' | 'unknown';
  name: string;
  /** Scheduler limits, e.g. `MaxTRESPU: "cpu=N,gres/gpu=8"`; "N" means no limit for that TRES. */
  limits: Record<string, string | null>;
  /**
   * What the limits are measured against, in the same format: `GrpTRES` is the whole QoS's
   * use, the per-user keys this login's own. Only reported keys are present; rows saved by
   * older versions have none, which means unknown, never zero.
   */
  usage?: Record<string, string>;
  origin: string;
}
export interface Source {
  id: string;
  /** Display label of the cluster or platform this login belongs to. */
  name: string;
  driver: string;
  kind: Kind;
  cluster_id: string;
  username: string;
  ssh_alias: string;
  credential: string;
  enabled: boolean;
  status: string;
  last_success: string | null;
  last_attempt: string | null;
  next_due_at?: string | null;
  failures?: number;
  error: Message | string | null;
  interval_minutes: number;
  capabilities: string[];
  capabilities_seen?: string[];
  history_window_seconds?: number | null;
  qos: QosLimit[];
  warnings?: (Message | string)[];
  stale?: boolean;
  cluster_state?: 'available' | 'degraded' | 'unavailable' | 'unknown';
  /** Driver-specific settings, such as a Kubernetes context or a cloud region. */
  options?: Record<string, string>;
  /** The collection machine that collects this source; empty for the service machine. */
  node?: string;
  /** What a cloud provider reported about the account, such as its balance. */
  account?: { balance: number | null; currency: string; observed_at?: string };
}
/** Another machine that collects sources for this service over SSH. */
export interface CollectionNode {
  id: string;
  name: string;
  ssh_alias: string;
  command: string;
  status: 'unchecked' | 'ok' | 'error';
  version: string | null;
  drivers: string[];
  checked_at: string | null;
  last_collected_at?: string | null;
  error: Message | null;
}
/** Text in several languages: `{ en: '...', 'zh-CN': '...' }`. */
export type Localized = Record<string, string>;
export interface DriverField {
  /** `username`, `ssh_alias`, `credential`, or the name of a driver option. */
  key: string;
  label: Localized;
  hint: Localized;
  placeholder: string;
  default: string;
  required: boolean;
  pattern: string | null;
  choices: string[] | null;
  /** Identifies one login of a cluster; fixed once the source exists. */
  identity: boolean;
}
export interface DriverCheck {
  capability: string;
  command: string;
  label: Localized;
  warning: string | null;
}
/** How a driver is presented and configured, from `GET /api/drivers`. */
export interface DriverInfo {
  name: string;
  kind: Kind;
  label: Localized;
  description: Localized;
  details: Localized;
  fields: DriverField[];
  checks: DriverCheck[];
  default_name: string;
  name_placeholder: string;
  beta: boolean;
}
export interface Job {
  id: string;
  array_id?: string | null;
  array_index?: string | null;
  source_id: string;
  cluster_id: string;
  name: string;
  user: string;
  account: string;
  partition: string | null;
  qos: string | null;
  state: string;
  gpu_count: number | null;
  gpu_type: string | null;
  cpu_count: number | null;
  node: string | null;
  elapsed: string;
  submitted_at?: string | null;
  started_at?: string | null;
  end?: string | null;
  exit_code?: string | null;
  exit_status?: number | null;
  exit_signal?: number | null;
  ended_at?: string | null;
  time_limit?: string | null;
  log_path?: string | null;
  reason: string | null;
  gpu_utilization: number | null;
  cpu_utilization: number | null;
  memory_utilization: number | null;
  observed_at: string | null;
}
export interface FailedJob extends Job {
  end: string | null;
  exit_code: string | null;
}
export interface Instance {
  id: string;
  source_id: string;
  /** Display label of the cloud or machine type, e.g. the RunPod source name. */
  platform: string;
  name: string;
  state: string;
  gpu_count: number | null;
  gpu_allocated?: number | null;
  gpu_type: string | null;
  gpu_utilization: number | null;
  cpu_utilization: number | null;
  memory_utilization: number | null;
  host: string | null;
  port: number | null;
  username: string;
  ssh_alias: string;
  identity_file: string | null;
  hourly_cost: number | null;
  currency: string;
  observed_at: string | null;
  ssh_status: string;
  monitoring?: boolean;
  manual?: boolean;
  existing_alias?: boolean;
  external_id?: string;
  gpu_observed_count?: number | null;
  metrics_scope?: string;
  ssh_error?: Message | string | null;
  /** When the last SSH check started; a provider listing keeps it while the endpoint holds. */
  last_probe_attempt?: string | null;
  /** Why a reading of the last check is unknown, e.g. `gpu_processes_unavailable`. */
  probe_warnings?: (Message | string)[];
}
export interface ComputeNode {
  health?: 'usable' | 'unavailable' | 'unknown';
  id: string;
  source_id: string;
  cluster_id: string;
  name: string;
  state: string;
  gpu_count: number | null;
  gpu_allocated: number | null;
  /** Model named by the scheduler's GRES, when it names one. */
  gpu_type?: string | null;
  cpu_count: number | null;
  cpu_allocated: number | null;
  partitions: string[];
  observed_at: string | null;
}
export interface HistoryPoint {
  at: string;
  allocated_gpus: number | null;
  gpu_utilization: number | null;
  coverage_count: number;
  known_allocated_gpus?: number | null;
  unknown_allocation_sources?: number;
}
export interface Unmeasured {
  subject: { kind: 'source' | 'instance'; id: string; name: string };
  reason: Message;
}
export interface NodeSummary {
  nodes: number;
  capacity: number | null;
  usable: number | null;
  known_usable: number | null;
  unavailable: number | null;
  allocated: number | null;
  unallocated: number | null;
  abnormal: number;
  unknown: number;
  observed_at: string | null;
  ratio: number | null;
}
export interface Summary {
  allocated: number | null;
  known_allocated: number | null;
  unknown_allocation_sources: number;
  unmeasured: Unmeasured[];
  unmonitored: number;
  requested: number | null;
  known_requested: number | null;
  queued_unmeasured: Unmeasured[];
  running: number | null;
  known_running: number;
  pending: number | null;
  known_pending: number;
  utilization: number | null;
  covered: number;
  cpu_utilization: number | null;
  memory_utilization: number | null;
  nodes: NodeSummary;
  jobs: {
    missing_source_ids: string[];
    known: number;
    total: number | null;
  };
}
export interface FleetSummary extends Summary {
  groups: Record<string, Summary>;
  sources: Record<string, Summary>;
  jobs: Summary['jobs'] & {
    current_ids: string[];
    listed_ids: string[];
    running_ids: string[];
    pending_ids: string[];
  };
}
export interface Attention {
  key: string;
  fingerprint?: string;
  mutable?: boolean;
  muted?: { state: 'acknowledged' | 'snoozed'; at: string; until: string | null } | null;
  kind: string;
  subject: { kind: 'source' | 'instance' | 'service' | 'plugin'; id: string; name: string };
  severity: 'error' | 'warn';
  message: Message;
  details: (Message | string)[];
  since: string | null;
  observed_at: string | null;
  next_attempt: string | null;
  action: 'diagnose' | 'instance' | 'health' | 'toolbox' | 'notify';
}
export interface Dashboard {
  token?: string;
  attention?: Attention[];
  attention_count?: number;
  summary: FleetSummary;
  mode: string;
  sources: Source[];
  jobs: Job[];
  instances: Instance[];
  nodes: ComputeNode[];
  history: HistoryPoint[];
  updated_at: string | null;
  as_of?: string | null;
  behind?: string[];
  collecting?: string[];
  refreshing: boolean;
  recent_failures?: FailedJob[];
  failure_history_sources?: string[];
  failure_history_observed_at?: string | null;
}
export interface SSHConfig {
  config: string;
  path: string;
  installed: boolean;
}
export interface Health {
  background_errors?: Record<string, { at: string; error: string }>;
  unreadable_rows?: Record<string, number>;
  server_host?: string;
  server_name?: string | null;
  status: string;
  started_at: string;
  database_path: string;
  polling: boolean;
  ssh_installed: boolean;
  source_count: number;
  /** Health details reported by installed plugins, keyed by plugin id. */
  plugins?: Record<string, Record<string, unknown>>;
}
export interface Settings {
  language: string;
  server_name: string | null;
}
/** A setting a plugin declares; the Toolbox renders it without plugin web code. */
export interface SettingField {
  key: string;
  label: Localized;
  hint: Localized;
  kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'credential';
  default: string | number | boolean | null;
  required: boolean;
  choices: string[] | null;
  placeholder: string;
}
/** One plugin in the Toolbox, from `GET /api/toolbox`. */
export interface Tool {
  id: string;
  /** Shipped with ComputeDeck, installed from a marketplace (with its tier), or directly. */
  /** Unknown while installed-plugins.json cannot be read (a note says why). */
  origin: {
    kind: 'builtin' | 'marketplace' | 'direct' | 'unknown';
    marketplace?: string;
    tier?: string;
  };
  name: Localized;
  description: Localized;
  enabled: boolean;
  default_enabled: boolean;
  page: string | null;
  /** An icon name from the manifest; see toolIcons.ts. */
  icon?: string;
  permissions: Localized[];
  version: string | null;
  package: string | null;
  author: string | null;
  homepage: string | null;
  requires: string | null;
  /** Why the plugin cannot run on this version, when it cannot. */
  rejected: Message | null;
  /** Base URL of the plugin package's web bundle. */
  web: string | null;
  /** Notices about the plugin, e.g. a declared web bundle that was not built. */
  notes: Message[];
  settings: SettingField[];
  values: Record<string, string | number | boolean | null>;
  health: Record<string, unknown>;
  errors: Record<string, { at: string; error: string }>;
}
/** Something that changed between two collections, from `GET /api/events`. */
export interface DeckEvent {
  id: number;
  group?: {
    count: number;
    ids: number[];
    first_at: string;
    last_at: string;
    names: { name: string; count: number }[];
    outcomes?: Record<string, number>;
    observed_time?: boolean;
    since?: string | null;
    events: DeckEvent[];
  };
  delivery?: ('sent' | 'failed' | 'suppressed' | 'grouped' | 'dropped')[];
  type:
    | 'job.finished'
    | 'job.started'
    | 'job.ended'
    | 'job.failed'
    | 'source.failed'
    | 'source.recovered'
    | string;
  at: string;
  source_id: string | null;
  data: {
    subject_id?: string;
    name?: string;
    action?: string;
    fields?: string[];
    counts?: { sources: number; nodes: number; instances: number };
    outcome?: string;
    outcome_reason?: 'outcomes_unavailable' | 'outcome_not_reported' | null;
    state?: string | null;
    exit_code?: string | null;
    submitted_at?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
    observed_at?: string;
    since?: string;
    from?: string;
    to?: string;
    unobserved_from?: string;
    unobserved_to?: string;
    failures_checked_from?: string | null;
    source_name?: string;
    driver?: string;
    cluster_id?: string;
    username?: string;
    job?: Partial<Job> & { exit_code?: string | null; end?: string | null };
    error?: Message | string;
  };
}
/** A plugin offered by an added marketplace, from `GET /api/marketplace`. */
export interface MarketPlugin {
  name: string;
  display_name: Localized | null;
  description: Localized | null;
  version: string;
  category: string | null;
  tags: string[];
  permissions: Localized[];
  requires: string | null;
  homepage: string | null;
  license: string | null;
  author: string | null;
  source_type: 'pypi' | 'wheel' | 'git' | 'path';
  marketplace: string;
  tier: 'official' | 'internal' | 'community' | 'local' | string;
  installed_version: string | null;
  update: boolean;
  compatible: boolean;
  blocked: boolean;
  command: string;
}
export interface Marketplaces {
  marketplaces: {
    name: string;
    kind: string;
    source: string;
    tier: string;
    updated_at: string;
    plugins: number;
    /** Why a catalog saved by an older version cannot be used; its plugins are not listed. */
    error?: string | null;
  }[];
  plugins: MarketPlugin[];
  policy_error: string | null;
}
