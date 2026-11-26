import { ClockText } from '../data/ClockText';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, isLocale, locales, t } from '../i18n';
import { relativeTime } from '../domain';
import { readClock, saveClock, type Clock } from '../format';
import { Panel, Status } from '../ui';
import { readTheme, readDensity, saveTheme, saveDensity, THEME_EVENT } from '../theme/preferences';
import type { Theme, Density } from '../theme/preferences';
import type { Ctx } from './shared';

export function SettingsPage({ ctx }: { ctx: Ctx }) {
  const { data, remote, health, demo, busy } = ctx;
  const panels =
    demo && !__TEST_PLUGIN_SLOTS__ ? [] : ctx.webPlugins.filter((plugin) => plugin.settings);
  return (
    // One column of sections: a heading, then each field's label over its control.
    <div className="settings">
      {panels.map((plugin) => {
        const Settings = plugin.settings!;
        return (
          <div className="plugin-slot" data-plugin={plugin.id} key={plugin.id}>
            <Settings {...ctx.plugin} />
          </div>
        );
      })}
      <LowUseSettings
        key={`${data.low_use_settings?.threshold}:${data.low_use_settings?.window_minutes}`}
        ctx={ctx}
      />
      <AppearanceSettings ctx={ctx} />
      <Panel>
        <div className="setting-row">
          <span>{t('settings.ssh')}</span>
          <button className="button" onClick={() => void ctx.showSSH()}>
            {remote ? t('settings.ssh.previewDownload') : t('settings.ssh.preview')}
          </button>
        </div>
        <div className="setting-row">
          <span>{t('settings.backup')}</span>
          <button className="button" disabled={busy || demo} onClick={() => void ctx.backup()}>
            {t('settings.backup.now')}
          </button>
        </div>
      </Panel>
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
            <dd>
              <ClockText>{() => relativeTime(health?.started_at)}</ClockText>
            </dd>
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
        <div className="setting-row">
          <label htmlFor="low-use-threshold">{t('lowUse.threshold')}</label>
          <input
            id="low-use-threshold"
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
        </div>
        <div className="setting-row">
          <label htmlFor="low-use-window">{t('lowUse.window')}</label>
          <input
            id="low-use-window"
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
        </div>
        <div className="setting-row">
          <button
            className="button small"
            disabled={
              ctx.demo ||
              ctx.busy ||
              saving ||
              // Nothing to save until a value changes.
              (threshold === (ctx.data.low_use_settings?.threshold ?? 10) &&
                windowMinutes === (ctx.data.low_use_settings?.window_minutes ?? 60))
            }
          >
            {t('common.save')}
          </button>
        </div>
        {message && <p role="alert">{message}</p>}
      </form>
    </Panel>
  );
}

function AppearanceSettings({ ctx }: { ctx: Ctx }) {
  const [theme, setTheme] = useState(readTheme);
  // The sidebar's switch changes the same preference.
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  const [density, setDensity] = useState(readDensity);
  const [clock, setClock] = useState(readClock);
  return (
    <Panel title={t('settings.appearance')}>
      <div className="setting-row">
        <label htmlFor="appearance-theme">{t('settings.theme')}</label>
        <select
          id="appearance-theme"
          value={theme}
          onChange={(event) => {
            const value = event.target.value as Theme;
            saveTheme(value);
            setTheme(value);
          }}
        >
          {(['system', 'light', 'dark'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`settings.theme.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="appearance-density">{t('settings.density')}</label>
        <select
          id="appearance-density"
          value={density}
          onChange={(event) => {
            const value = event.target.value as Density;
            saveDensity(value);
            setDensity(value);
          }}
        >
          {(['comfortable', 'compact'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`settings.density.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="appearance-clock">{t('settings.clock')}</label>
        <select
          id="appearance-clock"
          value={clock}
          onChange={(event) => {
            const value = event.target.value as Clock;
            saveClock(value);
            setClock(value);
          }}
        >
          {(['24', '12'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`settings.clock.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <label htmlFor="settings-language">{t('settings.language')}</label>
        <select
          id="settings-language"
          className="select"
          aria-label={t('settings.language')}
          value={ctx.pendingLocale ?? ctx.locale}
          aria-busy={!!ctx.pendingLocale}
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
  );
}
