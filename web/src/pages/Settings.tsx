import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { locales, t } from '../i18n';
import { isLocale } from '../i18n';
import { relativeTime } from '../domain';
import { routeHash } from '../routes';
import { Panel, Status } from '../ui';
import type { Ctx } from './shared';

export function SettingsPage({ ctx }: { ctx: Ctx }) {
  const { data, remote, health, demo, busy } = ctx;
  const panels = demo ? [] : ctx.webPlugins.filter((plugin) => plugin.settings);
  return (
    <div className="grid wide-narrow settings">
      <div className="stack">
        <Panel title={t('settings.sources')}>
          <div className="setting-row">
            <p>{t('settings.sourcesMoved', { count: data.sources.length })}</p>
            <a className="button" href={routeHash('sources')}>
              {t('sources.open')} <ArrowRight size={13} />
            </a>
          </div>
        </Panel>
        {panels.map((plugin) => {
          const Settings = plugin.settings!;
          return <Settings key={plugin.id} {...ctx.plugin} />;
        })}
        <Panel title={t('settings.language')}>
          <div className="setting-row">
            <p>{t('settings.languageHint')}</p>
            <select
              className="select"
              value={ctx.locale}
              aria-label={t('settings.language')}
              onChange={(event) => {
                if (isLocale(event.target.value)) ctx.changeLocale(event.target.value);
              }}
            >
              {locales.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </Panel>
        <Panel title={t('settings.ssh')}>
          <div className="setting-row">
            <p>
              {remote
                ? t('settings.ssh.remote', { server: ctx.serverName })
                : t('settings.ssh.local')}
            </p>
            <button className="button" onClick={() => void ctx.showSSH()}>
              {remote ? t('settings.ssh.previewDownload') : t('settings.ssh.preview')}
            </button>
          </div>
        </Panel>
        <Panel title={t('settings.backup')}>
          <div className="setting-row">
            <p>
              {remote
                ? t('settings.backup.remote', { server: ctx.serverName })
                : t('settings.backup.local')}
            </p>
            <button className="button" disabled={busy || demo} onClick={() => void ctx.backup()}>
              <ArrowDownToLine size={14} /> {t('settings.backup.now')}
            </button>
          </div>
        </Panel>
      </div>
      <Panel
        title={
          remote ? t('settings.service.remote', { server: ctx.serverName }) : t('settings.service')
        }
      >
        <dl className="kv">
          <div>
            <dt>{t('settings.service.state')}</dt>
            <dd>
              {health ? (
                <Status state="ready" label={t('settings.service.running')} />
              ) : (
                <Status state="unknown" label={t('settings.service.down')} />
              )}
            </dd>
          </div>
          <div>
            <dt>{t('settings.service.address')}</dt>
            <dd className="mono">
              {remote
                ? t('settings.service.tunnel', { server: ctx.serverName })
                : window.location.host}
            </dd>
          </div>
          <div>
            <dt>{t('settings.service.polling')}</dt>
            <dd>{health ? (health.polling ? t('common.on') : t('common.off')) : '—'}</dd>
          </div>
          <div>
            <dt>{t('settings.service.include')}</dt>
            <dd>
              {health
                ? health.ssh_installed
                  ? t('common.installed')
                  : t('common.notInstalled')
                : '—'}
            </dd>
          </div>
          <div>
            <dt>{t('settings.service.sources')}</dt>
            <dd>{health?.source_count ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('settings.service.started')}</dt>
            <dd>{relativeTime(health?.started_at)}</dd>
          </div>
        </dl>
        {health?.database_path && (
          <p className="panel-note">
            {t('settings.service.database')} <code className="path">{health.database_path}</code>
          </p>
        )}
      </Panel>
    </div>
  );
}
