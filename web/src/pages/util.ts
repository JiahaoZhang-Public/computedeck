import type { Instance } from '../types';
import { t } from '../i18n';

export const RECENT_MS = 12 * 60 * 1000;

export function recentlyReachable(item: Instance) {
  return (
    item.ssh_status === 'reachable' &&
    !!item.observed_at &&
    Date.now() - new Date(item.observed_at).getTime() < RECENT_MS
  );
}

export function matches(query: string, ...fields: (string | null | undefined)[]) {
  return fields.join(' ').toLowerCase().includes(query.trim().toLowerCase());
}

/** "this computer" or the remote server's name, for sentences about where things run. */
export function where(ctx: { remote: boolean; serverName: string }) {
  return ctx.remote ? ctx.serverName : t('where.local');
}
