import { useState } from 'react';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { api } from '../api';
import { errorText, isLocale, locales, t } from '../i18n';
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
            <p>
              {demo
                ? t('settings.sourcesMovedExample')
                : t('settings.sourcesMoved', { count: data.sources.length })}
            </p>
            <a className="button" href={routeHash('sources')}>
              {t('sources.open')} <ArrowRight size={13} />
            </a>
          </div>
        </Panel>
        {panels.map((plugin) => {
          const Settings = plugin.settings!;
          return <Settings key={plugin.id} {...ctx.plugin} />;
        })}
        <LowUseSettings
          key={`${data.low_use_settings?.threshold}:${data.low_use_settings?.window_minutes}`}
          ctx={ctx}
        />
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

function LowUseSettings({ ctx }: { ctx: Ctx }) {
  const [threshold, setThreshold] = useState(ctx.data.low_use_settings?.threshold ?? 10);
  const [windowMinutes, setWindowMinutes] = useState(
    ctx.data.low_use_settings?.window_minutes ?? 60,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <Panel title={t('lowUse.title')}>
      <form
        className="low-use-settings"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setMessage('');
          try {
            await api(
              '/settings',
              { low_use_threshold: threshold, low_use_window_minutes: windowMinutes },
              'PUT',
            );
            ctx.notify(t('lowUse.saved'));
            await ctx.reload();
          } catch (error) {
            setMessage(errorText(error, 'lowUse.saveError'));
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className="panel-note">{t('lowUse.settingsHint')}</p>
        <div className="setting-row">
          <label>
            {t('lowUse.threshold')}
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              step={1}
              required
              disabled={ctx.demo || saving}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
          </label>
          <label>
            {t('lowUse.window')}
            <input
              className="input"
              type="number"
              min={30}
              max={360}
              step={1}
              required
              disabled={ctx.demo || saving}
              value={windowMinutes}
              onChange={(event) => setWindowMinutes(Number(event.target.value))}
            />
          </label>
          <button className="button" disabled={ctx.demo || ctx.busy || saving}>
            {t('common.save')}
          </button>
        </div>
        {message && <p role="alert">{message}</p>}
      </form>
    </Panel>
  );
}
