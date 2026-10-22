// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitHistory, WaitHistoryNote } from './WaitHistory';
import { dateTime, relativeTime } from './domain';
import { groupsOf } from './groups';
import { lowUseDuration, setLocale, t } from './i18n';
import { JobDetail } from './pages/Details';
import { PlanPage } from './pages/Plan';
import type { Ctx } from './pages/shared';
import { planOptions } from './plan';
import { serverDemo } from './test-server';
import type { Job, WaitHistory as History } from './types';

let demo: ReturnType<typeof serverDemo>;
let ctx: Ctx;
let job: Job;
beforeAll(() => {
  demo = serverDemo();
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const data = structuredClone(demo);
  ctx = { data, groups: groupsOf(data), demo: true } as Ctx;
  job = data.jobs.find((row) => row.name === 'llm-sft / ablation')!;
  window.history.replaceState(null, '', '/?demo=true#/plan');
});
afterEach(() => {
  setLocale('en');
  vi.unstubAllGlobals();
});
function markup(element: React.ReactNode) {
  const view = document.createElement('div');
  view.innerHTML = renderToStaticMarkup(element);
  return view;
}
function history() {
  return ctx.data.wait_history![job.source_id];
}
function view(gpus: number | null = 1, qos: string | null = 'normal', partition?: string | null) {
  return markup(<WaitHistory history={history()} gpus={gpus} qos={qos} partition={partition} />);
}

describe.each(['en', 'zh-CN'] as const)('wait history in %s', (locale) => {
  beforeEach(() => setLocale(locale));
  it('shows the same percentiles, count and age in the drawer and planner', () => {
    const expected = t('wait.range', {
      low: lowUseDuration(38),
      high: lowUseDuration(93),
      count: 12,
    });
    const drawer = markup(<JobDetail job={job} ctx={ctx} />).querySelector('.wait-history')!;
    const planner = markup(<PlanPage ctx={ctx} />);
    expect(drawer.textContent).toContain(expected);
    expect(drawer.textContent).toContain(
      locale === 'en' ? '38 m – 1 h 33 m' : '38 分钟 – 1 小时 33 分钟',
    );
    expect(planner.textContent).toContain(expected);
    for (const text of [drawer.textContent, planner.textContent]) {
      expect(text).toContain(t('wait.title'));
      expect(text).toContain(t('wait.note'));
    }
    expect(drawer.textContent).toContain(t('wait.bucket', { gpus: 1 }));
    expect(drawer.textContent).toContain(t('wait.scope', { qos: 'normal', partition: 'gpu' }));
    expect(drawer.textContent).toContain(t('wait.asOf', { time: dateTime(history().observed_at) }));
    const options = planner.querySelector('.plan-options')!.closest('.panel')!;
    expect(options.querySelectorAll('.wait-history-note')).toHaveLength(1);
    expect(options.querySelector('.wait-history-note')!.textContent).toContain(t('wait.note'));
    expect(options.querySelector('.wait-history-note time')!.getAttribute('title')).toBe(
      dateTime(ctx.data.wait_history!['example:cluster-c-alice'].observed_at),
    );
    for (const row of planner.querySelectorAll('.plan-options .wait-history')) {
      expect(row.querySelector('time')).toBeNull();
      expect(row.textContent).not.toContain(t('wait.note'));
      expect(row.textContent).not.toContain(t('wait.partition', { partition: 'gpu' }));
    }
    const best = planner.querySelector('.plan-best')!;
    expect(best.querySelectorAll('.wait-history-note')).toHaveLength(1);
    expect(
      best
        .querySelector('.plan-comparison')!
        .compareDocumentPosition(best.querySelector('.wait-history')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(drawer.querySelector('time')!.dateTime).toBe(history().observed_at);
    // The best card is a different login: do not lend alice's range to bob.
    expect(planner.querySelector('.plan-best .wait-history')!.textContent).toContain(
      t('wait.unavailable'),
    );
    expect(planner.querySelector('.plan-best .wait-history')!.textContent).not.toContain(expected);
  });
  it('demonstrates insufficient history in the pending drawer and matching planner request', async () => {
    job = ctx.data.jobs.find((row) => row.name === 'rl-agent / rollout')!;
    window.history.replaceState(null, '', '/?demo=true#/plan?gpus=16');
    const expected = t('wait.insufficient', { count: 3 });
    expect(markup(<JobDetail job={job} ctx={ctx} />).textContent).toContain(expected);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PlanPage ctx={ctx} />));
      expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('16');
      expect(host.textContent).toContain(expected);
    } finally {
      await act(async () => root.unmount());
    }
    expect(view(16, 'long').textContent).toContain(t('wait.bucket', { gpus: '9–16' }));
  });
  it.each([0, 1, 7, 8])('requires eight samples (n=%i)', (count) => {
    const bucket = history().buckets[0];
    bucket.samples = count;
    bucket.p25_seconds = 0;
    bucket.p75_seconds = 30;
    for (const text of [
      view().textContent,
      markup(<WaitHistory compact history={history()} gpus={1} qos="normal" />).textContent,
    ]) {
      expect(text).toContain(
        count < 8
          ? t('wait.insufficient', { count })
          : t('wait.range', {
              low: t('wait.seconds', { count: 0 }),
              high: t('wait.seconds', { count: 30 }),
              count,
            }),
      );
    }
  });
  it('keeps unknown counts and absent buckets unknown without borrowing another request', () => {
    expect(view(null).textContent).toContain(t('wait.unknownGpus'));
    expect(view(8).textContent).toContain(t('wait.insufficient', { count: 0 }));
    expect(view(1, 'debug').textContent).toContain(t('wait.insufficient', { count: 0 }));
    expect(view(1, 'normal', 'other').textContent).toContain(t('wait.insufficient', { count: 0 }));
    expect(view(1, 'normal', null).textContent).toContain(t('wait.insufficient', { count: 0 }));
  });
  it('does not pool partitions and names missing partitions on multi-partition jobs', () => {
    history().buckets.push({
      ...history().buckets[0],
      partition: 'short',
      samples: 2,
      p25_seconds: null,
      p75_seconds: null,
    });
    const text = view(1, 'normal', 'gpu,short,other').textContent;
    expect(text).toContain(t('wait.scope', { qos: 'normal', partition: 'short' }));
    expect(text).toContain(t('wait.insufficient', { count: 2 }));
    expect(text).toContain(t('wait.scope', { qos: 'normal', partition: 'other' }));
    expect(text).toContain(t('wait.insufficient', { count: 0 }));
    expect(view().textContent).toContain(t('wait.insufficient', { count: 2 }));
  });
  it.each(['unavailable', 'unsupported', 'not_collected'] as const)(
    'explains %s accounting',
    (status) => {
      history().status = status;
      const text = view().textContent;
      expect(text).toContain(
        t(status === 'not_collected' ? 'wait.notCollected' : `wait.${status}`),
      );
      expect(markup(<PlanPage ctx={ctx} />).textContent).toContain(
        t(status === 'not_collected' ? 'wait.notCollected' : `wait.${status}`),
      );
      expect(text).not.toContain(t('wait.bucket', { gpus: 1 }));
    },
  );
  it('keeps old services without the additive field readable', () => {
    delete ctx.data.wait_history;
    expect(markup(<PlanPage ctx={ctx} />).textContent).toContain(t('wait.notCollected'));
    expect(markup(<JobDetail job={job} ctx={ctx} />).textContent).toContain(t('wait.notCollected'));
  });
  it('does not borrow history after a login identity changes', () => {
    ctx.data.sources.find((s) => s.id === job.source_id)!.username = 'bob';
    const text = markup(<JobDetail job={job} ctx={ctx} />).querySelector(
      '.wait-history',
    )!.textContent;
    expect(text).toContain(t('wait.ownOnly'));
    expect(text).not.toContain(t('wait.notCollected'));
    expect(text).not.toContain(t('wait.bucket', { gpus: 1 }));
  });
  it('labels unknown collection time instead of inventing a fresh observation', () => {
    history().observed_at = null;
    expect(view().textContent).toContain(t('wait.asOfUnknown'));
    expect(view().querySelector('time')).toBeNull();
  });
  it('keeps scheduler reasons and queue-position lines before typical waits', () => {
    job = ctx.data.jobs.find((j) => j.reason === 'Resources' && j.queue?.length)!;
    const drawer = markup(<JobDetail job={job} ctx={ctx} />);
    const callout = drawer.querySelector('.callout')!;
    expect(callout.textContent).toContain(t('job.reason'));
    expect(callout.textContent).toContain(t('job.queue.resources', { partition: 'gpu' }));
    expect(
      callout.compareDocumentPosition(drawer.querySelector('.wait-history')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it('shows partitions only to distinguish compact rows and never invents a missing selection', () => {
    const render = (gpus = 1) =>
      markup(<WaitHistory compact history={history()} qos="normal" gpus={gpus} />);
    expect(render().querySelectorAll('p')).toHaveLength(1);
    expect(render().textContent).toBe(
      t('wait.line', {
        value: t('wait.range', {
          low: lowUseDuration(38),
          high: lowUseDuration(93),
          count: 12,
        }),
      }),
    );
    expect(render(8).textContent).toBe(
      t('wait.line', { value: t('wait.insufficient', { count: 0 }) }),
    );
    history().buckets.push({
      ...history().buckets[0],
      partition: 'short',
      samples: 3,
      p25_seconds: null,
      p75_seconds: null,
    });
    const text = render().textContent;
    expect(text).toContain(t('wait.partition', { partition: 'gpu' }));
    expect(text).toContain(t('wait.partition', { partition: 'short' }));
    expect(text).toContain(t('wait.insufficient', { count: 3 }));
  });
  it('shows the oldest relevant accounting age once, with an absolute hover time', () => {
    const older = '2026-01-01T10:00:00Z';
    const newer = '2026-01-02T10:00:00Z';
    const histories: History[] = [
      { ...history(), observed_at: newer },
      { ...history(), observed_at: older },
      { ...history(), status: 'unsupported' as const, observed_at: '2020-01-01T00:00:00Z' },
    ];
    const note = markup(<WaitHistoryNote histories={histories} relative />);
    expect(note.querySelectorAll('time')).toHaveLength(1);
    expect(note.querySelector('time')!.dateTime).toBe(older);
    expect(note.querySelector('time')!.title).toBe(dateTime(older));
    expect(note.textContent).toContain(t('wait.asOf', { time: relativeTime(older) }));
    histories[0].observed_at = null;
    expect(markup(<WaitHistoryNote histories={histories} relative />).textContent).toContain(
      t('wait.asOfUnknown'),
    );
  });
  it.each([0, 30, 60, 2250, 3600, 5550])(
    'formats %i seconds without decimal hours or minutes',
    (seconds) => {
      history().buckets[0].p25_seconds = history().buckets[0].p75_seconds = seconds;
      const duration =
        seconds < 60
          ? t('wait.seconds', { count: seconds })
          : lowUseDuration(Math.round(seconds / 60));
      expect(view().textContent).toContain(
        t('wait.range', { low: duration, high: duration, count: 12 }),
      );
    },
  );
  it.each(['RUNNING', 'COMPLETED', 'FAILED'])(
    'does not show wait estimates for %s jobs',
    (state) => {
      job.state = state;
      expect(markup(<JobDetail job={job} ctx={ctx} />).querySelector('.wait-history')).toBeNull();
    },
  );
});

it('history never changes planner ranking or verdicts', () => {
  const request = { gpus: 1, gpuType: '', hours: null };
  const expected = planOptions(ctx.data, request);
  for (const h of Object.values(ctx.data.wait_history!)) {
    h.buckets = [{ ...history().buckets[0], samples: 500, p25_seconds: 0, p75_seconds: 0 }];
  }
  expect(planOptions(ctx.data, request)).toEqual(expected);
  delete ctx.data.wait_history;
  expect(planOptions(ctx.data, request)).toEqual(expected);
});
