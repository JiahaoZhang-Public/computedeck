import { ArrowDownToLine, Check, Copy, Loader2, Wifi } from 'lucide-react';
import type { Instance, Job, SSHConfig } from '../types';
import { groupLabel } from '../groups';
import { errorText, formatMessage, t } from '../i18n';
import { jobGpuResources, money, relativeTime, runningPrice } from '../domain';
import { directSSHCommand } from '../connections';
import { api } from '../api';
import { Meter, Status } from '../ui';
import type { Ctx } from './shared';

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
          <ArrowDownToLine size={14} /> {t('common.download')}
        </button>
        {!remote && (
          <button
            className="button primary"
            disabled={busy || config.installed || !config.config.trim()}
            onClick={() => void onInstall()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
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

export function JobDetail({ job, ctx }: { job: Job; ctx: Ctx }) {
  const gpu = jobGpuResources(job);
  const pending = job.state.toUpperCase() === 'PENDING';
  return (
    <div className="drawer-body">
      {pending && job.reason && (
        <div className="callout amber">
          <strong>{t('job.reason')}</strong>
          <span>{job.reason}</span>
        </div>
      )}
      <dl className="kv">
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
          <dd>{job.user}</dd>
        </div>
        <div>
          <dt>Slurm Account</dt>
          <dd>{job.account || '—'}</dd>
        </div>
        <div>
          <dt>Partition / QoS</dt>
          <dd>
            {job.partition || '—'} / {job.qos || '—'}
          </dd>
        </div>
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
        <div>
          <dt>{t('jobs.col.elapsed')}</dt>
          <dd className="mono">{job.elapsed || '—'}</dd>
        </div>
        <div>
          <dt>{t('common.sampledAt')}</dt>
          <dd>{relativeTime(job.observed_at)}</dd>
        </div>
      </dl>
      <Metrics
        values={[
          { label: 'GPU', value: job.gpu_utilization },
          { label: 'CPU', value: job.cpu_utilization },
          { label: t('common.memory'), value: job.memory_utilization },
        ]}
      />
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
  const { demo, remote, busy } = ctx;
  const direct = remote || !!item.existing_alias;
  async function copyCommand() {
    if (direct) {
      const command = directSSHCommand(item);
      if (command) await ctx.copy(command);
      return;
    }
    try {
      const config = await api<SSHConfig>('/ssh/config');
      await ctx.copy(
        config.installed
          ? `ssh ${item.ssh_alias}`
          : `ssh -F '${config.path.replaceAll("'", "'\\''")}' ${item.ssh_alias}`,
      );
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.sshConfig'), 'error');
    }
  }
  return (
    <div className="drawer-body">
      <div className="drawer-actions">
        <button
          className="button"
          disabled={demo || (direct && !directSSHCommand(item))}
          title={direct && !directSSHCommand(item) ? t('instance.noEndpoint') : undefined}
          onClick={() => void copyCommand()}
        >
          <Copy size={14} />
          {remote ? t('instance.copyDirect') : t('instance.copyCommand')}
        </button>
        <button
          className="button primary"
          disabled={busy || demo || !item.host}
          onClick={() => void onProbe()}
        >
          <Wifi size={14} />
          {remote ? t('instance.probeRemote', { server: ctx.serverName }) : t('instance.probe')}
        </button>
        {item.manual && (
          <>
            <button className="button" disabled={demo} onClick={onEdit}>
              {t('common.edit')}
            </button>
            <button
              className="button danger-text"
              disabled={demo || busy}
              onClick={() => {
                if (window.confirm(t('instance.deleteConfirm', { name: item.name })))
                  void onDelete();
              }}
            >
              {t('common.remove')}
            </button>
          </>
        )}
      </div>
      {item.ssh_status === 'error' && item.ssh_error && (
        <div className="callout red">
          <strong>{t('instance.probeFailed')}</strong>
          <span className="mono">{formatMessage(item.ssh_error)}</span>
        </div>
      )}
      <dl className="kv">
        <div>
          <dt>{t('usage.col.platform')}</dt>
          <dd>{item.platform}</dd>
        </div>
        <div>
          <dt>GPU</dt>
          <dd>
            {item.gpu_count ?? '?'} × {item.gpu_type || 'GPU'}
          </dd>
        </div>
        <div>
          <dt>{t('cloud.col.price')}</dt>
          <dd>
            {item.hourly_cost == null
              ? '—'
              : runningPrice(item) == null
                ? t('cloud.priceWhenRunning', { price: money(item.hourly_cost, item.currency) })
                : `${money(item.hourly_cost, item.currency)}/h`}
          </dd>
        </div>
        <div>
          <dt>{t('instance.sshState')}</dt>
          <dd>
            <Status state={item.ssh_status} />
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
        <div>
          <dt>{t('instance.id')}</dt>
          <dd className="mono">{item.id}</dd>
        </div>
        <div>
          <dt>{t('common.sampledAt')}</dt>
          <dd>{relativeTime(item.observed_at)}</dd>
        </div>
      </dl>
      <Metrics
        values={[
          { label: 'GPU', value: item.gpu_utilization },
          { label: 'CPU', value: item.cpu_utilization },
          { label: t('common.memory'), value: item.memory_utilization },
        ]}
      />
      <p className="panel-note">
        {remote ? t('instance.note.remote', { server: ctx.serverName }) : t('instance.note.local')}{' '}
        {t('instance.note.scope')}
      </p>
    </div>
  );
}
