import { useDialogFocus } from '../useDialogFocus';
import { useEffect, useState } from 'react';
import { Copy, Puzzle, X } from 'lucide-react';
import type { MarketPlugin, Marketplaces } from '../types';
import { api } from '../api';
import { errorText, localized, t } from '../i18n';
import { relativeTime } from '../domain';
import { TIER_LABELS, TIER_TONES } from '../tiers';
import { Empty, Panel } from '../ui';
import type { Ctx } from './shared';

function TierTag({ tier }: { tier: string }) {
  return (
    <span className={`tag tier ${TIER_TONES[tier] ?? 'gray'}`}>
      {TIER_LABELS[tier] ? t(TIER_LABELS[tier]) : tier}
    </span>
  );
}

function Command({ text, ctx }: { text: string; ctx: Ctx }) {
  return (
    <div className="command">
      <code>{text}</code>
      <button
        className="icon-button"
        aria-label={t('common.copy')}
        onClick={() => void ctx.copy(text)}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

function state(plugin: MarketPlugin): { text: string; tone: string } {
  if (plugin.blocked) return { text: t('market.blocked'), tone: 'red-text' };
  if (!plugin.compatible)
    return {
      text: t('market.incompatible', { requires: plugin.requires ?? '' }),
      tone: 'amber-text',
    };
  if (plugin.update)
    return {
      text: t('market.update', { have: plugin.installed_version ?? '', version: plugin.version }),
      tone: 'amber-text',
    };
  if (plugin.installed_version)
    return {
      text: t('market.installed', { version: plugin.installed_version }),
      tone: 'green-text',
    };
  return { text: t('market.available'), tone: 'muted' };
}

function PluginDrawer({
  plugin,
  ctx,
  onClose,
}: {
  plugin: MarketPlugin;
  ctx: Ctx;
  onClose: () => void;
}) {
  const dialog = useDialogFocus();
  const status = state(plugin);
  const installable =
    !plugin.blocked && plugin.compatible && (!plugin.installed_version || plugin.update);
  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        className="drawer tool-drawer"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div className="tool-drawer-title">
            <span className="tool-icon large">
              <Puzzle size={20} />
            </span>
            <div>
              <h2 id="plugin-title">{localized(plugin.display_name ?? {}) || plugin.name}</h2>
              <span className="tool-meta">
                <TierTag tier={plugin.tier} />{' '}
                {[
                  `${plugin.name}@${plugin.marketplace}`,
                  `v${plugin.version}`,
                  plugin.author,
                  plugin.license,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>
          <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="drawer-body">
          <p className={status.tone}>{status.text}</p>
          {plugin.description && <p>{localized(plugin.description)}</p>}
          {plugin.permissions.length > 0 && (
            <section className="tool-permissions">
              <h3>{t('toolbox.permissions')}</h3>
              <ul>
                {plugin.permissions.map((item) => (
                  <li key={localized(item)}>{localized(item)}</li>
                ))}
              </ul>
            </section>
          )}
          {installable && (
            <section className="tool-permissions">
              <h3>{t('market.howToInstall')}</h3>
              <p className="muted">{t('market.installNote', { where: ctx.serverName })}</p>
              <Command text={plugin.command} ctx={ctx} />
            </section>
          )}
          <p className="tool-meta">
            {t('market.source', { kind: plugin.source_type })}
            {plugin.requires && ` · ComputeDeck ${plugin.requires}`}
          </p>
          {plugin.homepage && /^https:\/\//.test(plugin.homepage) && (
            <a className="link" href={plugin.homepage} target="_blank" rel="noreferrer">
              {t('toolbox.homepage')}
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}

/** What the added marketplaces offer; installing is done on the service machine. */
export function MarketplaceTab({ ctx }: { ctx: Ctx }) {
  const [data, setData] = useState<Marketplaces | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<MarketPlugin | null>(null);
  useEffect(() => {
    api<Marketplaces>('/marketplace')
      .then(setData)
      .catch((reason) => setError(errorText(reason, 'error.service')));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (error) return <p className="page-note red-text">{error}</p>;
  if (!data) return <p className="page-note">{t('chart.loading')}</p>;
  const add = 'computedeck plugin marketplace add <owner/repo | URL | folder>';
  if (!data.marketplaces.length)
    return (
      <Panel>
        <Empty
          title={t('market.none')}
          text={t('market.noneHint', { where: ctx.serverName })}
          action={<Command text={add} ctx={ctx} />}
        />
      </Panel>
    );
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const plugins = data.plugins.filter((plugin) =>
    words.every((word) =>
      [
        plugin.name,
        localized(plugin.display_name ?? {}),
        localized(plugin.description ?? {}),
        ...plugin.tags,
      ]
        .join(' ')
        .toLowerCase()
        .includes(word),
    ),
  );
  return (
    <>
      {data.policy_error && <p className="page-note red-text">{data.policy_error}</p>}
      {data.marketplaces.map(
        (market) =>
          market.error && (
            <p key={market.name} className="page-note red-text">
              {market.error}
            </p>
          ),
      )}
      <div className="market-sources">
        {data.marketplaces.map((market) => (
          <span key={market.name} className="market-source" title={market.source}>
            <strong>{market.name}</strong> <TierTag tier={market.tier} />
            <small>
              {t('market.count', { count: market.plugins })} · {relativeTime(market.updated_at)}
            </small>
          </span>
        ))}
        <details className="market-add">
          <summary>{t('market.addAnother')}</summary>
          <Command text={add} ctx={ctx} />
        </details>
      </div>
      {data.plugins.length > 3 && (
        <label className="search market-search">
          <input
            value={query}
            placeholder={t('market.search')}
            aria-label={t('market.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="tool-tiles">
        {plugins.map((plugin) => {
          const status = state(plugin);
          return (
            <article key={`${plugin.name}@${plugin.marketplace}`} className="tool-tile">
              <button className="tool-tile-main" onClick={() => setOpen(plugin)}>
                <span className="tool-icon">
                  <Puzzle size={18} />
                </span>
                <span className="tool-tile-text">
                  <strong>
                    {localized(plugin.display_name ?? {}) || plugin.name}{' '}
                    <TierTag tier={plugin.tier} />
                  </strong>
                  <span className="tool-tile-description">
                    {localized(plugin.description ?? {})}
                  </span>
                </span>
              </button>
              <footer>
                <span className={`tool-status ${status.tone}`}>{status.text}</span>
                <span className="muted">v{plugin.version}</span>
              </footer>
            </article>
          );
        })}
      </div>
      {!plugins.length && <p className="page-note">{t('market.noMatch')}</p>}
      <p className="page-note">{t('market.installNote', { where: ctx.serverName })}</p>
      {open && <PluginDrawer plugin={open} ctx={ctx} onClose={() => setOpen(null)} />}
    </>
  );
}
