import { computeHealth } from '../health';
import { locale, t } from '../i18n';
import type { LiveSnapshot } from './store';

/** Announce state transitions, never ages, sample times or the initial inventory. */
export function transitions(before: LiveSnapshot, after: LiveSnapshot, demo: boolean): string {
  if (!before.data || !after.data || before.data.mode !== after.data.mode) return '';
  if (
    before.data === after.data &&
    before.health === after.health &&
    before.error === after.error &&
    before.needsToken === after.needsToken &&
    before.nodes === after.nodes
  )
    return '';
  const messages: string[] = [];
  const health = (snapshot: LiveSnapshot) =>
    computeHealth(
      snapshot.data,
      snapshot.health,
      snapshot.error,
      snapshot.needsToken,
      demo,
      snapshot.nodes,
    ).label;
  if (health(before) !== health(after)) messages.push(t('live.health', { status: health(after) }));
  // Dashboard jobs are deduplicated by id; twin logins may alternate as their source.
  const previous = new Map(before.data.jobs.map((job) => [job.id, job.state]));
  const current = new Map(after.data.jobs.map((job) => [job.id, job.state]));
  const added = [...current.keys()].filter((id) => !previous.has(id)).length;
  const updated = [...current].filter(
    ([id, state]) => previous.has(id) && previous.get(id) !== state,
  ).length;
  const left = [...previous.keys()].filter((id) => !current.has(id)).length;
  if (added) messages.push(t('live.jobsAdded', { count: added }));
  if (updated) messages.push(t('live.jobsChanged', { count: updated }));
  if (left) messages.push(t('live.jobsLeft', { count: left }));
  if (
    before.data.attention_count !== after.data.attention_count &&
    after.data.attention_count !== undefined
  )
    messages.push(t('live.attention', { count: after.data.attention_count }));
  return messages.join(locale() === 'zh-CN' ? '；' : '. ');
}
