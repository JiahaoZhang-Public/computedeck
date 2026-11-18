import { phoneMedia } from '../breakpoints';
import { ClockText } from '../data/ClockText';
import { useMedia } from '../layers/stack';
import { useConfirm } from '../layers/useConfirm';
import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Ellipsis, Loader2 } from 'lucide-react';
import { MenuButton } from '../layers/Popover';
import type { DeckEvent, GpuRow, Instance, Job, SSHConfig } from '../types';
import { failureEnd, failureExplanation, inspectionCommand } from '../failures';
import { jobReason, jobTime, jobWaiting } from '../jobFacts';
import { groupLabel } from '../groups';
import { errorText, formatMessage, t } from '../i18n';
import {
  dateTime,
  percentage,
  arrayField,
  groupArrays,
  instanceAllocation,
  jobGpuResources,
  listedJobs,
  lowUseText,
  money,
  PENDING_STATES,
  relativeTime,
  runningPrice,
  runningSince,
} from '../domain';
import { directSSHCommand, routeJump } from '../connections';
import { jobPlanLink } from '../submit';
import { jobTerms } from '../labels';
import { api } from '../api';
import { Meter, Status } from '../ui';
import type { Ctx } from './shared';
import { InstanceRunCost, JobsTable, MachineNodeNote } from './shared';
import { snoozeItems } from './snooze';
import { WaitHistory } from '../WaitHistory';
import { waitRange } from '../waitRange';

export function SSHConfigView({
  config,
  remote,
  serverName,
  busy,
  onInstall,
}: {
  config: SSHConfig;
  remote: boolean;
  serverName: string;
  busy: boolean;
  onInstall: () => Promise<void>;
}) {
  return (
    <>
      <header className="modal-header">
        <h2 id="modal-title">{remote ? t('ssh.title.remote') : t('ssh.title')}</h2>
        <p>{remote ? t('ssh.intro.remote', { server: serverName }) : t('ssh.intro')}</p>
      </header>
      <div className="config-path">
        <code>{config.path}</code>
        {!remote && (
          <Status
            state={config.installed ? 'ready' : 'unconfigured'}
            label={config.installed ? t('common.installed') : t('common.notInstalled')}
          />
        )}
      </div>
      <pre className="config-preview">{config.config || t('ssh.empty')}</pre>
      <footer className="modal-footer">
        <button
          className="button"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([config.config], { type: 'text/plain' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = 'computedeck.conf';
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          {t('common.download')}
        </button>
        {!remote && (
          <button
            className="button primary"
            disabled={busy || config.installed || !config.config.trim()}
            onClick={() => void onInstall()}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {config.installed ? t('common.installed') : t('ssh.install')}
          </button>
        )}
      </footer>
    </>
  );
}

function Metrics({ values }: { values: { label: string; value: number | null | undefined }[] }) {
  if (values.every((item) => item.value == null)) return null;
  return (
    <div className="drawer-metrics">
      {values.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <Meter value={item.value ?? null} />
        </div>
      ))}
    </div>
  );
}

/** The drawer follows the full listed array on each poll, independently of page filters. */
export function ArrayDetail({ jobs, ctx }: { jobs: Job[]; ctx: Ctx }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(50);
  const terms = jobTerms(
    ctx.data.sources.find((source) => source.id === jobs[0].source_id)?.driver ?? '',
  );
  const array = groupArrays(jobs).find((row) => 'jobs' in row);
  const user = arrayField(jobs, 'user');
  const qos = arrayField(jobs, 'qos');
  const partition = arrayField(jobs, 'partition');
  const fact = ({ value, mixed }: ReturnType<typeof arrayField>) =>
    mixed ? t('jobs.array.mixed') : value || '—';
  return (
    <div
      className="drawer-body array-detail"
      ref={listRef}
      tabIndex={-1}
      aria-label={t('jobs.array.elements', { count: jobs.length })}
    >
      <p>{t('jobs.array.elements', { count: jobs.length })}</p>
      {array && 'jobs' in array && (
        <p>
          {[
            t('jobs.array.running', { count: array.running }),
            t('jobs.array.pending', { count: array.pending }),
            t('jobs.array.other', { count: array.other }),
          ].join(t('common.listSeparator'))}
        </p>
      )}
      <dl className="kv">
        <div>
          <dt>{t('job.cluster')}</dt>
          <dd>{groupLabel(ctx.groups, jobs[0].cluster_id)}</dd>
        </div>
        <div>
          <dt>{t('job.user')}</dt>
          <dd>{fact(user)}</dd>
        </div>
        {terms.qos && (
          <div>
            <dt>{t(terms.qos)}</dt>
            <dd>{fact(qos)}</dd>
          </div>
        )}
        <div>
          <dt>{t(terms.partition)}</dt>
          <dd>{fact(partition)}</dd>
        </div>
      </dl>
      <JobsTable
        compact
        jobs={jobs.slice(0, limit)}
        groups={ctx.groups}
        onOpen={ctx.openJob}
        stale={listedJobs(ctx.data).stale}
        empty={null}
      />
      {jobs.length > limit && (
        <div className="drawer-actions">
          <button
            className="button"
            onClick={() => {
              listRef.current?.focus();
              setLimit(limit + 50);
            }}
          >
            {t('jobs.array.showMore')}
          </button>
          <button
            className="button"
            onClick={() => {
              listRef.current?.focus();
              setLimit(Infinity);
            }}
          >
            {t('jobs.array.showAll')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Underline tabs inside a drawer. Hidden panels stay in the document for search and print. */
function DrawerTabs({
  tabs,
}: {
  tabs: { id: string; label: string; content: ReactNode | false | null | undefined }[];
}) {
  const shown = tabs.filter((tab) => tab.content);
  const [selected, setSelected] = useState(shown[0]?.id);
  const active = shown.some((tab) => tab.id === selected) ? selected : shown[0]?.id;
  const id = useId();
  return (
    <>
      <div className="chips drawer-tabs" role="tablist" aria-label={t('drawer.sections')}>
        {shown.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${id}-${tab.id}-tab`}
            aria-selected={tab.id === active}
            aria-controls={`${id}-${tab.id}`}
            className={tab.id === active ? 'active' : ''}
            onClick={() => setSelected(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {shown.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${id}-${tab.id}`}
          aria-labelledby={`${id}-${tab.id}-tab`}
          className="drawer-panel"
          hidden={tab.id !== active}
        >
          {tab.content}
        </div>
      ))}
    </>
  );
}

/** Two or three key figures, laid out like stat tiles. */
function Figures({ items }: { items: { label: string; value: ReactNode; tag?: string }[] }) {
  return (
    <dl className="figures">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.tag && <span className="tag">{item.tag}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A command shown as it will be copied, with the copy action at the row's end. */
function CommandRow({
  text,
  label,
  copy,
  disabled,
}: {
  text: string;
  label: string;
  copy: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="command-row">
      <code>{text}</code>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={copy}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

export function JobDetail({ job, ctx, event }: { job: Job; ctx: Ctx; event?: DeckEvent }) {
  const gpu = jobGpuResources(job);
  const source = ctx.data.sources.find((source) => source.id === job.source_id);
  const driver = event?.data.driver ?? source?.driver ?? '';
  const terms = jobTerms(driver);
  const failure = failureExplanation(job, driver);
  const historical = !!event || !!job.end || !!failure;
  const pending = !historical && PENDING_STATES.includes(job.state.toUpperCase());
  const explanation = pending ? jobReason(job, driver) : null;
  const nextStep = failure ? jobReason(job, driver)?.next : null;
  const command =
    historical && event?.data.outcome_reason !== 'outcomes_unavailable'
      ? inspectionCommand(job, driver)
      : null;
  const unknownEnd =
    event?.type === 'job.ended' ||
    (event?.type === 'job.finished' && event.data.outcome === 'unknown');
  const observed = event
    ? (event.data.observed_at ?? event.at)
    : historical
      ? ctx.data.failure_history_observed_at
      : job.observed_at;
  const phone = useMedia(phoneMedia);
  const actions = (pending || failure) && (
    <div className="drawer-actions">
      <a className="button primary" href={jobPlanLink(job, ctx.data.nodes)}>
        {t('plan.findAnother')}
      </a>
    </div>
  );
  const history = ctx.data.wait_history?.[job.source_id];
  const ownHistory =
    history?.status === 'unsupported' ||
    (source?.username === job.user && source.cluster_id === job.cluster_id);
  const typical = ownHistory ? waitRange(history, job.qos, job.partition, job.gpu_count) : null;
  const gpus = `${(pending ? gpu.requested : gpu.allocated) ?? '—'} × ${job.gpu_type || 'GPU'}`;
  const overview = (
    <>
      {event && <p className="panel-note">{t('event.recordedJob')}</p>}
      {unknownEnd && (
        <p className="callout">
          <ClockText>
            {() => t('event.lastSeenEnded', { time: relativeTime(job.observed_at) })}
          </ClockText>
          {event?.type === 'job.finished' && (
            <>
              {' '}
              {t(
                event.data.outcome_reason === 'outcomes_unavailable'
                  ? 'event.unknownUnavailable'
                  : event.data.outcome_reason === 'outside_lookback'
                    ? 'event.outsideLookback'
                    : 'event.unknownNotReported',
              )}
            </>
          )}
        </p>
      )}
      {failure && (
        <div className="callout red failure-explanation">
          {/* The scheduler's code is the chip beside the state; the sentence leads here. */}
          {failure.summary && <p className="lead">{failure.summary}</p>}
          {failure.evidence && <p>{failure.evidence}</p>}
          {nextStep && <p>{nextStep}</p>}
        </div>
      )}
      {explanation && (
        <div className="callout">
          <p className="lead">
            {driver === 'slurm' && explanation.kind === 'priority' && job.queue?.length
              ? t('job.queue.priorityReported')
              : explanation.summary}
          </p>
          {driver === 'slurm' && ['priority', 'resources'].includes(explanation.kind) && (
            <>
              {job.queue?.length ? (
                job.queue.map(({ partition, ahead, ties }) => (
                  <p key={partition}>
                    {t(
                      ahead === 0 && ties === 0
                        ? explanation.kind === 'resources'
                          ? 'job.queue.resources'
                          : 'job.queue.front'
                        : ties
                          ? ahead === 0
                            ? 'job.queue.upTo'
                            : 'job.queue.range'
                          : 'job.queue.ahead',
                      { partition, count: ahead, max: ahead + ties },
                    )}
                  </p>
                ))
              ) : (
                <p>
                  {t(
                    job.queue_unknown === undefined
                      ? 'job.queue.notCollected'
                      : job.queue_unknown === 'private_data'
                        ? 'job.queue.private'
                        : 'job.queue.failed',
                  )}
                </p>
              )}
              <p>
                {job.fairshare != null
                  ? t('job.queue.fairshare', {
                      account: job.account,
                      factor: job.fairshare.toFixed(2),
                    })
                  : t(
                      job.fairshare === undefined
                        ? 'job.queue.fairshareNotCollected'
                        : job.queue_unknown === 'failed'
                          ? 'job.queue.fairshareFailed'
                          : 'job.queue.fairshareUnknown',
                    )}
              </p>
            </>
          )}
          <p>{explanation.next}</p>
        </div>
      )}
      <Figures
        items={
          pending
            ? [
                {
                  label: t('wait.label'),
                  value: typical ?? '—',
                  tag: typical ? t('wait.tag') : undefined,
                },
                { label: t('job.requestedGpus'), value: gpus },
                { label: t('job.waiting'), value: jobWaiting(job) },
              ]
            : historical
              ? [
                  {
                    label: t(
                      unknownEnd || event?.type === 'job.started'
                        ? 'jobs.col.elapsed'
                        : 'failure.ranFor',
                    ),
                    value:
                      job.elapsed && job.time_limit
                        ? t('failure.ranLimit', { elapsed: job.elapsed, limit: job.time_limit })
                        : job.elapsed || '—',
                  },
                  ...(job.exit_code != null
                    ? [{ label: t('jobs.col.exitCode'), value: job.exit_code }]
                    : []),
                  ...(job.ended_at || job.end
                    ? [
                        {
                          label: t('jobs.col.ended'),
                          value: <ClockText>{() => failureEnd(job)}</ClockText>,
                        },
                      ]
                    : []),
                ]
              : [
                  { label: t('job.allocatedGpus'), value: gpus },
                  { label: t('jobs.col.elapsed'), value: job.elapsed || '—' },
                  { label: t('job.node'), value: job.node || '—' },
                ]
        }
      />
      {!historical && (
        <Metrics
          values={[
            { label: 'GPU', value: job.gpu_utilization },
            { label: 'CPU', value: job.cpu_utilization },
            { label: t('common.memory'), value: job.memory_utilization },
          ]}
        />
      )}
      {pending && (
        <details className="drawer-more">
          <summary>{t('wait.how')}</summary>
          {ownHistory ? (
            <WaitHistory
              history={history}
              qos={job.qos}
              partition={job.partition}
              gpus={job.gpu_count}
            />
          ) : (
            <p className="wait-history">{t('wait.ownOnly')}</p>
          )}
        </details>
      )}
    </>
  );
  const details = (
    <>
      <dl className="kv">
        {!historical && (job.ended_at || job.end) && (
          <div>
            <dt>{t('jobs.col.ended')}</dt>
            <dd title={jobTime(job.ended_at || job.end)}>
              <ClockText>{() => failureEnd(job)}</ClockText>
            </dd>
          </div>
        )}
        {!historical && job.exit_code != null && (
          <div>
            <dt>{t('jobs.col.exitCode')}</dt>
            <dd>{job.exit_code}</dd>
          </div>
        )}
        <div>
          <dt>{t('job.id')}</dt>
          <dd className="mono">{job.id}</dd>
        </div>
        <div>
          <dt>{t('job.cluster')}</dt>
          <dd>{groupLabel(ctx.groups, job.cluster_id)}</dd>
        </div>
        <div>
          <dt>{t('job.user')}</dt>
          <dd>{job.user || '—'}</dd>
        </div>
        <div>
          <dt>{t(terms.account)}</dt>
          <dd>{job.account || '—'}</dd>
        </div>
        <div>
          <dt>{t(terms.partition)}</dt>
          <dd>{job.partition || '—'}</dd>
        </div>
        {terms.qos && (
          <div>
            <dt>{t(terms.qos)}</dt>
            <dd>{job.qos || '—'}</dd>
          </div>
        )}
        <div>
          <dt>{pending ? t('job.requestedGpus') : t('job.allocatedGpus')}</dt>
          <dd>
            {(pending ? gpu.requested : gpu.allocated) ?? '—'} × {job.gpu_type || 'GPU'}
          </dd>
        </div>
        <div>
          <dt>{t('job.cpus')}</dt>
          <dd>{job.cpu_count ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('job.node')}</dt>
          <dd className="mono">{job.node || '—'}</dd>
        </div>
        {(!historical || job.submitted_at) && (
          <div>
            <dt>{t('job.submitted')}</dt>
            <dd>{jobTime(job.submitted_at)}</dd>
          </div>
        )}
        {(!historical || job.started_at) && (
          <div>
            <dt>{t('job.started')}</dt>
            <dd>{jobTime(job.started_at)}</dd>
          </div>
        )}
        {(!historical || (job.submitted_at && job.started_at)) && (
          <div>
            <dt>{t('job.waiting')}</dt>
            <dd>{jobWaiting(job)}</dd>
          </div>
        )}
        {!historical && (
          <div>
            <dt>{t('jobs.col.elapsed')}</dt>
            <dd className="mono">
              {pending
                ? '—'
                : job.elapsed && job.time_limit
                  ? t('failure.ranLimit', { elapsed: job.elapsed, limit: job.time_limit })
                  : job.elapsed || '—'}
            </dd>
          </div>
        )}
        {job.time_limit && !job.elapsed && (
          <div>
            <dt>{t('failure.limit')}</dt>
            <dd>{job.time_limit}</dd>
          </div>
        )}
        {job.log_path && (
          <div>
            <dt>{t('failure.logPath')}</dt>
            <dd className="mono">{job.log_path}</dd>
          </div>
        )}
        <div>
          <dt>
            {t(
              event
                ? 'event.observedAt'
                : historical
                  ? 'failure.historyUpdated'
                  : 'common.sampledAt',
            )}
          </dt>
          <dd title={jobTime(observed)}>
            <ClockText>{() => relativeTime(observed)}</ClockText>
          </dd>
        </div>
      </dl>
      {command && (
        <section className="drawer-section">
          <h3>{t('failure.inspection')}</h3>
          <CommandRow
            text={command}
            label={t('failure.copyInspection')}
            copy={() => void ctx.copy(command, { kind: 'command' })}
          />
        </section>
      )}
    </>
  );
  return (
    <div className="drawer-body">
      {!phone && actions}
      <DrawerTabs
        tabs={[
          { id: 'overview', label: t('drawer.overview'), content: overview },
          { id: 'details', label: t('drawer.details'), content: details },
        ]}
      />
      {phone && actions}
    </div>
  );
}

export function InstanceDetail({
  item,
  ctx,
  onProbe,
  onEdit,
  onDelete,
}: {
  item: Instance;
  ctx: Ctx;
  onProbe: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirm, confirmation] = useConfirm();
  const { demo, remote, busy } = ctx;
  const direct = remote || !!item.existing_alias;
  // Busy GPUs, as the last SSH check counted them.
  const inUse = instanceAllocation(item);
  const since = runningSince(item);
  const source = ctx.data.sources.find((entry) => entry.id === item.source_id);
  async function copyCommand() {
    if (direct) {
      const command = directSSHCommand(item, routeJump(source, ctx.nodes));
      if (command) await ctx.copy(command, { kind: 'command' });
      return;
    }
    try {
      const config = await api<SSHConfig>('/ssh/config');
      await ctx.copy(
        config.installed
          ? `ssh ${item.ssh_alias}`
          : `ssh -F '${config.path.replaceAll("'", "'\\''")}' ${item.ssh_alias}`,
        { kind: 'command' },
      );
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.sshConfig'), 'error');
    }
  }
  const phone = useMedia(phoneMedia);
  const jump = routeJump(source, ctx.nodes);
  const command = direct
    ? directSSHCommand(item, jump)
    : item.ssh_alias
      ? `ssh ${item.ssh_alias}`
      : null;
  const snooze = snoozeItems(ctx, item.id);
  const actions = (
    <div className="drawer-actions">
      <button
        className="button primary"
        disabled={busy || demo || !item.host}
        onClick={() => void onProbe()}
      >
        {remote ? t('instance.probeRemote', { server: ctx.serverName }) : t('instance.probe')}
      </button>
      {/* One action row: the check, then everything else (edit, remove, snooze) in "⋯". */}
      {(item.manual || snooze.length > 0) && (
        <MenuButton
          className="icon-button"
          aria-label={t('drawer.more')}
          items={[
            ...(item.manual
              ? [
                  { id: 'edit', label: t('common.edit'), disabled: demo, action: onEdit },
                  {
                    id: 'remove',
                    label: t('common.remove'),
                    disabled: demo || busy,
                    action: async () => {
                      if (
                        await confirm(
                          t('instance.deleteConfirm', { name: item.name }),
                          t('layer.removeInstance'),
                        )
                      )
                        void onDelete();
                    },
                  },
                ]
              : []),
            ...snooze,
          ]}
        >
          <Ellipsis size={16} />
        </MenuButton>
      )}
    </div>
  );
  const overview = (
    <>
      {item.ssh_status === 'error' && item.ssh_error && (
        <div className="callout red">
          <strong>{t('instance.probeFailed')}</strong>
          <span className="mono">{formatMessage(item.ssh_error)}</span>
        </div>
      )}
      <MachineNodeNote item={item} />
      <Figures
        items={[
          { label: 'GPU', value: `${item.gpu_count ?? '?'} × ${item.gpu_type || 'GPU'}` },
          ...(item.manual || item.metrics_scope === 'host_visible'
            ? [{ label: t('instance.gpusBusy'), value: inUse ?? '—' }]
            : []),
          {
            label: t('cost.price'),
            value:
              runningPrice(item) == null
                ? '—'
                : t('usage.hourlyRate', { price: money(runningPrice(item)!, item.currency) }),
          },
        ]}
      />
      {(item.manual || item.metrics_scope === 'host_visible') &&
        inUse == null &&
        !!item.probe_warnings?.length && (
          <p className="panel-note">{formatMessage(item.probe_warnings[0])}</p>
        )}
      {item.gpu_count !== 0 && (
        <section className="drawer-section">
          <h3>{t('lowUse.title')}</h3>
          {item.low_use?.state === 'low' ? (
            <p>{lowUseText(item, ctx.data.low_use_settings)}</p>
          ) : item.low_use?.state === 'busy' ? (
            <p className="panel-note">
              {t('lowUse.busy', { threshold: ctx.data.low_use_settings?.threshold ?? 10 })}
            </p>
          ) : (
            <p className="panel-note">
              {t('lowUse.unknown')}
              {' · '}
              {t(`lowUse.${item.low_use?.reason ?? 'no_reading'}`, {
                minutes: ctx.data.low_use_settings?.window_minutes ?? 60,
              })}{' '}
              {item.manual
                ? !item.monitoring && t('lowUse.monitor')
                : ['runpod', 'lambda', 'aws-ec2', 'gpuhub'].includes(source?.driver ?? '') &&
                    ['no_reading', 'coverage', 'stale'].includes(
                      item.low_use?.reason ?? 'no_reading',
                    )
                  ? t('lowUse.providerMissing')
                  : ''}
            </p>
          )}
          {item.low_use?.origin === 'provider' && item.low_use.state !== 'low' && (
            <p className="panel-note">{t('lowUse.provider')}</p>
          )}
        </section>
      )}
      <Metrics
        values={[
          { label: 'GPU', value: item.gpu_utilization },
          { label: 'CPU', value: item.cpu_utilization },
          { label: t('common.memory'), value: item.memory_utilization },
        ]}
      />
      {item.console_url?.startsWith('https://') && (
        <a className="link" href={item.console_url} target="_blank" rel="noreferrer">
          {t('lowUse.console')}
        </a>
      )}
    </>
  );
  const connect = (
    <>
      {command && (
        <section className="drawer-section">
          <h3>{remote ? t('instance.copyDirect') : t('instance.copyCommand')}</h3>
          <CommandRow
            text={command}
            label={remote ? t('instance.copyDirect') : t('instance.copyCommand')}
            copy={() => void copyCommand()}
            disabled={demo}
          />
          <p className="panel-note">
            {remote
              ? t('instance.note.remote', { server: ctx.serverName })
              : t('instance.note.local')}
          </p>
        </section>
      )}
      <dl className="kv">
        <div>
          <dt>{t('instance.sshState')}</dt>
          <dd>
            <Status state={item.ssh_status} />
            {item.last_probe_attempt && (
              <span className="muted">
                {' · '}
                <ClockText>
                  {() => t('instance.checked', { time: relativeTime(item.last_probe_attempt) })}
                </ClockText>
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{item.existing_alias ? t('instance.existingAlias') : t('instance.hostPort')}</dt>
          <dd className="mono">
            {item.existing_alias ? item.host : `${item.host || '—'}:${item.port ?? '—'}`}
          </dd>
        </div>
        <div>
          <dt>{t('instance.username')}</dt>
          <dd className="mono">{item.username}</dd>
        </div>
        <div>
          <dt>{t('cloud.col.alias')}</dt>
          <dd className="mono">{item.ssh_alias || '—'}</dd>
        </div>
        <div>
          <dt>
            {remote ? t('instance.keyRemote', { server: ctx.serverName }) : t('instance.key')}
          </dt>
          <dd className="mono">{item.identity_file || t('instance.defaultKey')}</dd>
        </div>
      </dl>
    </>
  );
  const cost = (
    <dl className="kv">
      <div>
        <dt>{t('cost.price')}</dt>
        <dd>
          {item.hourly_cost == null
            ? '—'
            : runningPrice(item) == null
              ? t('cloud.priceWhenRunning', { price: money(item.hourly_cost, item.currency) })
              : t('cost.perInstance', { price: money(item.hourly_cost, item.currency) })}
          {item.hourly_cost != null && (item.gpu_count ?? 0) > 0 && (
            <span className="sub">
              {t('cost.perGpu', {
                price: money(item.hourly_cost / item.gpu_count!, item.currency),
              })}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>{t('cost.since')}</dt>
        <dd>
          {since
            ? t(`cost.since.${since.origin}`, { time: dateTime(since.at) })
            : item.manual
              ? t('cost.manualStartUnknown')
              : '—'}
        </dd>
      </div>
      <div>
        <dt>{t('cost.thisRun')}</dt>
        <dd>
          <InstanceRunCost item={item} source={source} />
        </dd>
      </div>
    </dl>
  );
  const details = (
    <>
      <dl className="kv">
        <div>
          <dt>{t('usage.col.platform')}</dt>
          <dd>{item.platform}</dd>
        </div>
        <div>
          <dt>{t('instance.id')}</dt>
          <dd className="mono">{item.id}</dd>
        </div>
        <div>
          <dt>{t('common.sampledAt')}</dt>
          <dd>
            <ClockText>{() => relativeTime(item.observed_at)}</ClockText>
          </dd>
        </div>
      </dl>
      <p className="panel-note">{t('instance.note.scope')}</p>
    </>
  );
  return (
    <div className="drawer-body">
      {confirmation}
      {!phone && actions}
      <DrawerTabs
        tabs={[
          { id: 'overview', label: t('drawer.overview'), content: overview },
          { id: 'connect', label: t('drawer.connect'), content: connect },
          {
            id: 'hardware',
            label: t('gpu.title'),
            content: !!item.gpus?.length && <GpuDetails item={item} />,
          },
          { id: 'cost', label: t('drawer.cost'), content: cost },
          { id: 'details', label: t('drawer.details'), content: details },
        ]}
      />
      {phone && actions}
    </div>
  );
}

function gpuMemory(value: number | null) {
  return value == null ? '—' : `${Math.round((value / 1024) * 10) / 10} GiB`;
}

function gpuOwners(gpu: GpuRow) {
  const owners = new Map<string | null, { count: number; memory: number | null }>();
  for (const process of gpu.processes ?? []) {
    const owner = owners.get(process.user) ?? { count: 0, memory: 0 };
    owner.count += 1;
    owner.memory =
      owner.memory == null || process.memory_mb == null ? null : owner.memory + process.memory_mb;
    owners.set(process.user, owner);
  }
  const labels = [...owners]
    .sort(([, a], [, b]) => (b.memory ?? -1) - (a.memory ?? -1) || b.count - a.count)
    .slice(0, 2)
    .map(([user, owner]) =>
      t('gpu.owner', {
        user: user ?? t('gpu.unknownUser'),
        count: owner.count,
        memory: gpuMemory(owner.memory),
      }),
    );
  if (owners.size > 2) labels.push(t('gpu.moreOwners', { count: owners.size - 2 }));
  if (gpu.processes_omitted) labels.push(t('gpu.omitted', { count: gpu.processes_omitted }));
  return labels.join(' · ');
}

function GpuDetails({ item }: { item: Instance }) {
  if (!item.gpus?.length) return null;
  return (
    <section className="gpu-details">
      <h3>{t('gpu.title')}</h3>
      <p className="panel-note" title={dateTime(item.gpus_observed_at)}>
        <ClockText>
          {() =>
            item.gpus_observed_at
              ? t('gpu.sampled', { time: relativeTime(item.gpus_observed_at) })
              : t('gpu.sampleUnknown')
          }
        </ClockText>
      </p>
      <ul className="rows">
        {item.gpus.map((gpu, index) => {
          const owners = gpuOwners(gpu);
          return (
            <li key={index}>
              <div className="grow">
                <strong>
                  {gpu.index ?? '—'} · {gpu.name ?? t('status.unknown')}
                </strong>
                <span className="sub">
                  {t('gpu.memory', {
                    used: gpuMemory(gpu.memory_used_mb),
                    total: gpuMemory(gpu.memory_total_mb),
                  })}{' '}
                  · {t('gpu.utilization', { value: percentage(gpu.utilization) })}
                </span>
                {owners && <span className="sub">{owners}</span>}
                <span className="tag">
                  {t(
                    gpu.in_use == null
                      ? 'status.unknown'
                      : !gpu.in_use
                        ? 'gpu.free'
                        : gpu.processes?.length
                          ? 'gpu.busy'
                          : 'gpu.busyHidden',
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
