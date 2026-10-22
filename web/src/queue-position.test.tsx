// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupsOf } from './groups';
import { formatMessage, setLocale, t } from './i18n';
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
      t('job.queue.range', { count: 20, max: 22, partition: 'gpu' }),
    );
    expect(callout.textContent).toContain(
      t('job.queue.fairshare', { account: job.account, factor: '0.12' }),
    );
    expect(view.textContent).toContain(t('common.sampledAt'));
    expect(callout.textContent).toContain(t('job.nextStep'));
  });
  it.each([0, 1, 3])(
    'keeps the measured count %i (including zero) and has singular wording',
    (count) => {
      job.queue = [{ partition: 'gpu', ahead: count, ties: 0 }];
      job.fairshare = 0;
      const text = drawer().textContent;
      expect(text).toContain(t('job.queue.ahead', { count, partition: 'gpu' }));
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
    expect(text).toContain(t('job.queue.ahead', { partition: 'debug', count: 0 }));
  });
  it('shows next in line only for a Resources job with no earlier rows or ties', () => {
    job = ctx.data.jobs.find((row) => row.reason === 'Resources')!;
    expect(job.queue).toEqual([{ partition: 'gpu', ahead: 0, ties: 0 }]);
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.resources', { partition: 'gpu' }));
    expect(text).not.toContain(t('job.queue.ahead', { partition: 'gpu', count: 0 }));
  });
  it('shows the count for the example Resources job with jobs ahead', () => {
    job = ctx.data.jobs.find((row) => row.array_index === '24')!;
    expect(job.reason).toBe('Resources');
    expect(job.queue).toEqual([{ partition: 'gpu', ahead: 19, ties: 0 }]);
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.ahead', { partition: 'gpu', count: 19 }));
    expect(text).not.toContain(t('job.queue.resources', { partition: 'gpu' }));
  });
  it.each([0, 3])('shows a range for a Resources job with %i ahead and ties', (ahead) => {
    job.reason = 'Resources';
    job.queue = [{ partition: 'gpu', ahead, ties: 2 }];
    const text = drawer().textContent;
    expect(text).toContain(
      t('job.queue.range', { partition: 'gpu', count: ahead, max: ahead + 2 }),
    );
    expect(text).not.toContain(t('job.queue.resources', { partition: 'gpu' }));
  });
  it.each(['private_data', 'failed'] as const)('explains an unknown queue: %s', (reason) => {
    job.queue = null;
    job.queue_unknown = reason;
    job.fairshare = null;
    const text = drawer().textContent;
    expect(text).toContain(t(reason === 'private_data' ? 'job.queue.private' : 'job.queue.failed'));
    if (reason === 'failed') expect(text).toContain(t('job.queue.fairshareUnknown'));
    expect(text).not.toContain(t('job.queue.ahead', { partition: 'gpu', count: 0 }));
  });
  it('keeps old stored rows unknown and translates the optional warning', () => {
    delete job.queue;
    delete job.queue_unknown;
    delete job.fairshare;
    const text = drawer().textContent;
    expect(text).toContain(t('job.queue.failed'));
    expect(text).toContain(t('job.queue.fairshareUnknown'));
    expect(formatMessage({ code: 'queue_unavailable' })).toBe(t('msg.queue_unavailable'));
  });
  it.each(['pbs', 'lsf', 'kubernetes'])('adds no Slurm facts to %s jobs', (driver) => {
    ctx.data.sources.find((source) => source.id === job.source_id)!.driver = driver;
    expect(drawer().textContent).not.toContain(
      t('job.queue.fairshare', { account: job.account, factor: '0.12' }),
    );
  });
  it.each([
    ['PENDING', 'Dependency'],
    ['PENDING', 'QOSMaxGRESPerUser'],
    ['RUNNING', 'Priority'],
  ])('hides queue facts when the job is %s / %s', (state, reason) => {
    job.state = state;
    job.reason = reason;
    expect(drawer().textContent).not.toContain(
      t('job.queue.range', { partition: 'gpu', count: 20, max: 22 }),
    );
  });
});
