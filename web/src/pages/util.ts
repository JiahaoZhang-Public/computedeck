import type { Instance } from '../types';
import { t } from '../i18n';

export const RECENT_MS = 12 * 60 * 1000;

export function recentlyReachable(item: Instance) {
  if (item.ssh_status !== 'reachable' || !item.last_probe_attempt) return false;
  const age = Date.now() - new Date(item.last_probe_attempt).getTime();
  return age >= -RECENT_MS && Math.max(0, age) < RECENT_MS;
}

export function matches(query: string, ...fields: (string | null | undefined)[]) {
  return fields.join(' ').toLowerCase().includes(query.trim().toLowerCase());
}

/** "this computer" or the remote server's name, for sentences about where things run. */
export function where(ctx: { remote: boolean; serverName: string }) {
  return ctx.remote ? ctx.serverName : t('where.local');
}
