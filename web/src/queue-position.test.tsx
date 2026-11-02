// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupsOf } from './groups';
import { jobTime, relativeStart, startEstimateLabel } from './jobFacts';
import { formatMessage, setLocale, t } from './i18n';
import type { MessageKey } from './i18n';
import { JobDetail } from './pages/Details';
import type { Ctx } from './pages/shared';
import { serverDemo } from './test-server';
import type { Job } from './types';

let demo: ReturnType<typeof serverDemo>;
let ctx: Ctx;
let job: Job;
beforeAll(() => {
  demo = serverDemo();
});
beforeEach(() => {
  const data = structuredClone(demo);
  ctx = { data, groups: groupsOf(data) } as Ctx;
  job = data.jobs.find((row) => row.reason === 'Priority' && row.queue != null)!;
});
afterEach(() => setLocale('en'));
function drawer() {
  const element = document.createElement('div');
  element.innerHTML = renderToStaticMarkup(<JobDetail job={job} ctx={ctx} />);
  return element;
}

describe.each(['en', 'zh-CN'] as const)('queue estimates in %s', (locale) => {
  beforeEach(() => setLocale(locale));
  it('shows example ties, account factor and observation time inside the waiting callout', () => {
    const view = drawer();
    const callout = view.querySelector('.callout')!;
    expect(callout.textContent).toContain(
      t('job.queue.upTo', { count: 0, max: 20, partition: 'gpu' }),
    );
    expect(callout.textContent).toContain(
      t('job.queue.fairshare', { account: job.account, factor: '0.12' }),
    );
    expect(callout.textContent).toContain(startEstimateLabel(job));
    expect(callout.textContent).toContain(t('job.startEstimate.inHours', { count: 3 }));
    const started = [...view.querySelectorAll('dt')].find(
      (row) => row.textContent === t('job.started'),
    );
    expect(started?.nextElementSibling?.textContent).toBe('—');
    expect(view.textContent).toContain(t('common.sampledAt'));
    expect(callout.textContent).toContain(t('job.nextStep'));
  });
  it.each([0, 1, 3])(
    'renders count %i with no-one-ahead wording for zero and singular wording for one',
    (count) => {
      job.queue = [{ partition: 'gpu', ahead: count, ties: 0 }];
      job.fairshare = 0;
      const text = drawer().textContent;
      expect(text).toContain(
        t(count === 0 ? 'job.queue.front' : 'job.queue.ahead', { count, partition: 'gpu' }),
      );
      expect(text).toContain(t('job.queue.priorityReported'));
      expect(text).not.toContain(t('job.explain.priority'));
      expect(text).toContain(t('job.queue.fairshare', { account: job.account, factor: '0.00' }));
      expect(text).not.toContain(t('job.queue.failed'));
      if (locale === 'en' && count === 1) expect(text).toContain('About 1 job ahead');
    },
  );
  it('shows each partition without combining their ranks', () => {
    job.queue = [
      { partition: 'gpu', ahead: 4, ties: 1 },
      { partition: 'debug', ahead: 0, ties: 0 },
    ];
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.range', { partition: 'gpu', count: 4, max: 5 }));
    expect(text).toContain(t('job.queue.front', { partition: 'debug' }));
  });
  it('shows next in line only for a Resources job with no earlier rows or ties', () => {
    job = ctx.data.jobs.find((row) => row.reason === 'Resources')!;
    expect(job.queue).toEqual([{ partition: 'gpu', ahead: 0, ties: 0 }]);
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.resources', { partition: 'gpu' }));
    expect(text).not.toContain(t('job.queue.ahead', { partition: 'gpu', count: 0 }));
  });
  it('shows a range for the example Resources job with tied earlier siblings', () => {
    job = ctx.data.jobs.find((row) => row.array_index === '24')!;
    expect(job.reason).toBe('Resources');
    expect(job.queue).toEqual([{ partition: 'gpu', ahead: 0, ties: 19 }]);
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.upTo', { partition: 'gpu', count: 0, max: 19 }));
    expect(text).not.toContain(t('job.queue.resources', { partition: 'gpu' }));
  });
  it.each([0, 3])('shows a range for a Resources job with %i ahead and ties', (ahead) => {
    job.reason = 'Resources';
    job.queue = [{ partition: 'gpu', ahead, ties: 2 }];
    const text = drawer().textContent;
    expect(text).toContain(
      t(ahead === 0 ? 'job.queue.upTo' : 'job.queue.range', {
        partition: 'gpu',
        count: ahead,
        max: ahead + 2,
      }),
    );
    expect(text).not.toContain(t('job.queue.resources', { partition: 'gpu' }));
  });
  it.each(['private_data', 'failed', null] as const)('explains an unknown queue: %s', (reason) => {
    job.queue = null;
    job.queue_unknown = reason;
    job.fairshare = null;
    const text = drawer().textContent;
    expect(text).toContain(t(reason === 'private_data' ? 'job.queue.private' : 'job.queue.failed'));
    expect(text).not.toContain(t('job.queue.notCollected'));
    expect(text).toContain(
      t(reason === 'failed' ? 'job.queue.fairshareFailed' : 'job.queue.fairshareUnknown'),
    );
    expect(text).not.toContain(t('job.queue.ahead', { partition: 'gpu', count: 0 }));
  });
  it('keeps old stored rows unknown and translates the optional warning', () => {
    delete job.queue;
    delete job.queue_unknown;
    delete job.fairshare;
    delete job.expected_start_at;
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.notCollected'));
    expect(text).not.toContain(t('job.queue.failed'));
    expect(text).toContain(t('job.queue.fairshareNotCollected'));
    expect(text).toContain(t('job.startEstimate.notCollected'));
    expect(formatMessage({ code: 'queue_unavailable' })).toBe(t('msg.queue_unavailable'));
  });
  it('shows Slurm’s expected start in the viewer’s timezone with a rough relative time', () => {
    const at = new Date(Date.now() + (3 * 60 + 20) * 60000).toISOString();
    job.expected_start_at = at;
    const text = drawer().textContent ?? '';
    const relative = relativeStart(at);
    expect(text).toContain(t('job.startEstimate', { time: jobTime(at), relative }));
    expect(text).toContain(t('job.startEstimate.inHours', { count: 3 }));
    expect(relative).toBe(t('job.startEstimate.inHours', { count: 3 }));
    expect(text).not.toContain(t('job.schedulerTime', { time: at }));
  });
  it.each<[number, MessageKey, number | undefined]>([
    [20 * 1000, 'job.startEstimate.soon', undefined],
    [-20 * 1000, 'job.startEstimate.justPassed', undefined],
    // Half a minute inside the bucket so a slow render still floors to 45.
    [45 * 60000 + 30 * 1000, 'job.startEstimate.inMinutes', 45],
    [-(45 * 60000 + 30 * 1000), 'job.startEstimate.minutesAgo', 45],
    [(3 * 60 + 20) * 60000, 'job.startEstimate.inHours', 3],
    [-(3 * 60 + 20) * 60000, 'job.startEstimate.hoursAgo', 3],
    [(2 * 1440 + 30) * 60000, 'job.startEstimate.inDays', 2],
    [-(2 * 1440 + 30) * 60000, 'job.startEstimate.daysAgo', 2],
  ])('phrases a start %i ms away as %s', (offset, key, count) => {
    job.expected_start_at = new Date(Date.now() + offset).toISOString();
    const text = drawer().textContent ?? '';
    const relative = t(key, count === undefined ? undefined : { count });
    expect(text).toContain(relative);
    expect(text).toContain(
      t('job.startEstimate', { time: jobTime(job.expected_start_at), relative }),
    );
  });
  it('leaves an unavailable or hidden start unknown and does not show it as started', () => {
    job.expected_start_at = null;
    let text = drawer().textContent ?? '';
    expect(text).toContain(t('job.startEstimate.unknown'));
    expect(text).not.toContain(t('job.startEstimate.notCollected'));
    const at = new Date(Date.now() + (3 * 60 + 20) * 60000).toISOString();
    job.expected_start_at = at;
    job.queue_unknown = 'private_data';
    job.queue = null;
    text = drawer().textContent ?? '';
    expect(text).toContain(t('job.queue.private'));
    expect(text).toContain(
      t('job.startEstimate', { time: jobTime(at), relative: relativeStart(at) }),
    );
    expect(text).toContain(t('job.startEstimate.inHours', { count: 3 }));
    expect(text).not.toContain(t('job.startEstimate.unknown'));
    job.expected_start_at = '2026-01-05T08:00:00';
    job.queue_unknown = null;
    text = drawer().textContent ?? '';
    expect(text).toContain(t('job.schedulerTime', { time: '2026-01-05T08:00:00' }));
    expect(text).toContain(
      t('job.startEstimate.absolute', { time: jobTime(job.expected_start_at) }),
    );
  });
  it.each(['pbs', 'lsf', 'kubernetes'])('adds no Slurm facts to %s jobs', (driver) => {
    ctx.data.sources.find((source) => source.id === job.source_id)!.driver = driver;
    const text = drawer().textContent ?? '';
    expect(text).not.toContain(t('job.queue.fairshare', { account: job.account, factor: '0.12' }));
    expect(text).not.toContain(startEstimateLabel(job));
  });
  it.each([
    ['PENDING', 'Dependency'],
    ['PENDING', 'QOSMaxGRESPerUser'],
    ['RUNNING', 'Priority'],
  ])('hides queue facts when the job is %s / %s', (state, reason) => {
    job.state = state;
    job.reason = reason;
    const text = drawer().textContent ?? '';
    expect(text).not.toContain(t('job.queue.upTo', { partition: 'gpu', count: 0, max: 20 }));
    expect(text).not.toContain(t('job.startEstimate.inHours', { count: 3 }));
  });
});
