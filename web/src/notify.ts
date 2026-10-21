import type { Message } from './i18n';
import type { Localized, SettingField } from './types';

/** Shapes served by the notifications tool under /api/plugins/notify. */
export interface Channel {
  id: string;
  name: string;
  kind: string;
  config: Record<string, string | number | boolean | null>;
}
export interface ChannelKind {
  kind: string;
  label: Localized;
  fields: SettingField[];
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  events: string[];
  outcomes?: string[];
  clusters: string[];
  users: string[];
  name_pattern: string;
  channels: string[];
  subject: string;
  body: string;
  include_log: boolean;
  agent: boolean;
  instructions: string;
}
export type RuleInput = Omit<Rule, 'id'>;
export interface Delivery {
  id: number;
  at: string;
  status: 'sent' | 'failed' | 'suppressed' | 'dropped';
  rule?: string;
  rule_name?: string;
  channel?: string;
  channel_name?: string;
  subject?: string;
  error?: Message | null;
  notes?: string[];
  test?: boolean;
}
export interface NotifyState {
  channels: Channel[];
  rules: Rule[];
  kinds: ChannelKind[];
  event_types: string[];
  placeholders: string[];
  log: Delivery[];
  ai_ready: boolean;
}

export const EMPTY_RULE: RuleInput = {
  name: '',
  enabled: true,
  events: ['job.finished'],
  outcomes: [
    'failed',
    'timeout',
    'out_of_memory',
    'node_fail',
    'boot_fail',
    'deadline',
    'preempted',
  ],
  clusters: [],
  users: [],
  name_pattern: '',
  channels: [],
  subject: '',
  body: '',
  include_log: false,
  agent: false,
  instructions: '',
};

/** Split "a, b; c" into trimmed, non-empty items. */
export function listOf(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The one value that tells a channel apart: its recipients or its webhook format. */
export function channelSummary(channel: Channel): string {
  if (channel.kind === 'email') return String(channel.config.recipients ?? '');
  if (channel.kind === 'webhook')
    return `${String(channel.config.format ?? 'json')} · ${String(channel.config.url ?? '')}`;
  return '';
}

/** Standard SMTP ports: 465 for implicit TLS (SSL), 587 for submission with or without STARTTLS. */
const SMTP_PORTS = ['465', '587'];

/**
 * The port an email channel form should show after its encryption changes, or null to keep
 * the port. A port the user typed is kept; an untouched standard port follows the encryption,
 * so choosing SSL does not leave the STARTTLS default 587 in place.
 */
export function smtpPortFor(security: string, port: string, touched: boolean): string | null {
  const current = port.trim();
  if (touched || !(current === '' || SMTP_PORTS.includes(current))) return null;
  const next = security === 'ssl' ? '465' : '587';
  return next === current ? null : next;
}
