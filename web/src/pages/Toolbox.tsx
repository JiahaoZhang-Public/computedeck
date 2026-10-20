import { useDialogFocus } from '../useDialogFocus';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ExternalLink, Puzzle, Search, X } from 'lucide-react';
import type { Tool } from '../types';
import { ApiError, errorText, formatMessage, localized, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { pagesOf, useWebPlugins } from '../plugins';
import { routeHash } from '../routes';
import { readSettings } from '../settingValues';
import type { Values } from '../settingValues';
import { SettingInput } from '../SettingInput';
import { TIER_LABELS, TIER_TONES } from '../tiers';
import { toolIcons } from '../toolIcons';
import { Chips, Empty, Panel, Switch } from '../ui';
import { MarketplaceTab } from './Marketplace';
import type { Ctx } from './shared';

/** Settings a tool needs before it can be switched on. */
function missing(tool: Tool) {
  return tool.settings.filter(
    (field) => field.required && [null, undefined, ''].includes(tool.values[field.key] as never),
  );
}

function summary(tool: Tool): string {
  const text = tool.health?.summary;
  return text && typeof text === 'object' ? localized(text as Record<string, string>) : '';
}

export function OriginTag({ tool }: { tool: Tool }) {
  const { origin } = tool;
  if (origin?.kind === 'unknown') return null;
  if (origin?.kind === 'marketplace')
    return (
      <span className={`tag tier ${TIER_TONES[origin.tier ?? ''] ?? 'gray'}`}>
        {TIER_LABELS[origin.tier ?? ''] ? t(TIER_LABELS[origin.tier ?? '']) : origin.tier}
      </span>
    );
  return (
    <span className="tag tier">
      {origin?.kind === 'builtin' ? t('toolbox.builtIn') : t('toolbox.direct')}
    </span>
  );
}

/** A server message about a setting names the setting by its label, not its key. */
function settingError(tool: Tool, reason: unknown) {
  if (reason instanceof ApiError && reason.detail && typeof reason.detail !== 'string') {
    const detail = reason.detail;
    const field = tool.settings.find((item) => item.key === detail.setting);
    if (field) return formatMessage({ ...detail, setting: localized(field.label) });
  }
  return errorText(reason, 'error.save');
}

function ToolTile({
  tool,
  page,
  ctx,
  onOpen,
  onToggle,
}: {
  tool: Tool;
  page?: string;
  ctx: Ctx;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const Icon = toolIcons[tool.icon ?? ''] ?? Puzzle;
  const status = tool.rejected
    ? formatMessage(tool.rejected)
    : tool.enabled
      ? summary(tool)
      : missing(tool).length
        ? t('toolbox.needsSetup')
        : '';
  return (
    <article className={`tool-tile ${tool.enabled ? 'on' : ''} ${tool.rejected ? 'broken' : ''}`}>
      <button
        id={`tool-details-${tool.id}`}
        className="tool-tile-main"
        onClick={onOpen}
        aria-label={t('toolbox.details', { name: localized(tool.name) })}
      >
        <span className="tool-icon">
          <Icon size={18} />
        </span>
        <span className="tool-tile-text">
          <strong>
            {localized(tool.name)} <OriginTag tool={tool} />
          </strong>
          <span className="tool-tile-description">{localized(tool.description)}</span>
        </span>
      </button>
      <footer>
        <span className={`tool-status ${tool.rejected ? 'red-text' : tool.enabled ? '' : 'muted'}`}>
          {status}
        </span>
        {tool.enabled && page && (
          <a className="button small" href={routeHash(page)}>
            {t('toolbox.openShort')} <ArrowRight size={12} />
          </a>
        )}
        <Switch
          checked={tool.enabled}
          name={localized(tool.name)}
          disabled={ctx.demo || !!tool.rejected}
          label={tool.enabled ? t('toolbox.on') : t('toolbox.off')}
          onChange={onToggle}
        />
      </footer>
    </article>
  );
}

function ToolDrawer({
  tool,
  page,
  ctx,
  onClose,
  onToggle,
}: {
  tool: Tool;
  page?: string;
  ctx: Ctx;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const dialog = useDialogFocus(`tool-details-${tool.id}`);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const Icon = toolIcons[tool.icon ?? ''] ?? Puzzle;
  const failures = Object.values(tool.errors);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const values: Values = readSettings(tool.settings, new FormData(event.currentTarget));
      await ctx.updateTool(tool.id, { settings: values });
      ctx.notify(t('toolbox.saved', { name: localized(tool.name) }));
    } catch (reason) {
      setError(settingError(tool, reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <aside
        className="drawer tool-drawer"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div className="tool-drawer-title">
            <span className="tool-icon large">
              <Icon size={20} />
            </span>
            <div>
              <h2 id="tool-title">{localized(tool.name)}</h2>
              <span className="tool-meta">
                <OriginTag tool={tool} />{' '}
                {[tool.version && `v${tool.version}`, tool.package, tool.author]
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
          <div className="tool-drawer-actions">
            {tool.rejected ? (
              <span className="red-text">{formatMessage(tool.rejected)}</span>
            ) : (
              <button
                className={`button ${tool.enabled ? '' : 'primary'}`}
                disabled={ctx.demo}
                onClick={() => onToggle(!tool.enabled)}
              >
                {tool.enabled ? t('toolbox.turnOff') : t('toolbox.turnOn')}
              </button>
            )}
            {tool.enabled && page && (
              <a className="button" href={routeHash(page)} onClick={onClose}>
                {t('toolbox.open', { name: localized(tool.name) })} <ArrowRight size={13} />
              </a>
            )}
            {tool.homepage && /^https:\/\//.test(tool.homepage) && (
              <a className="link" href={tool.homepage} target="_blank" rel="noreferrer">
                {t('toolbox.homepage')} <ExternalLink size={12} />
              </a>
            )}
          </div>
          {tool.enabled && summary(tool) && <p className="tool-summary">{summary(tool)}</p>}
          {Object.keys(tool.description).length > 0 && <p>{localized(tool.description)}</p>}
          {tool.permissions.length > 0 && (
            <section className="tool-permissions">
              <h3>{t('toolbox.permissions')}</h3>
              <ul>
                {tool.permissions.map((item) => (
                  <li key={localized(item)}>{localized(item)}</li>
                ))}
              </ul>
            </section>
          )}
          {failures.map((failure) => (
            <p key={failure.at} className="red-text">
              {t('toolbox.loopError', { error: failure.error })}
            </p>
          ))}
          {tool.notes?.map((note) => (
            <p key={note.code} className="amber-text">
              {formatMessage(note)}
            </p>
          ))}
          {tool.settings.length > 0 && (
            <form className="tool-settings" onSubmit={(event) => void save(event)}>
              <h3>{t('toolbox.settings')}</h3>
              <div className="form-grid">
                {tool.settings.map((field) => (
                  <SettingInput key={field.key} field={field} value={tool.values[field.key]} />
                ))}
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <footer>
                <button className="button" type="submit" disabled={saving || ctx.demo}>
                  {t('common.save')}
                </button>
              </footer>
            </form>
          )}
        </div>
      </aside>
    </div>
  );
}

function ConfirmEnable({
  tool,
  onCancel,
  onConfirm,
  onSetup,
}: {
  tool: Tool;
  onCancel: () => void;
  onConfirm: () => void;
  onSetup: () => void;
}) {
  const dialog = useDialogFocus(`tool-details-${tool.id}`);
  const needed = missing(tool);
  const Icon = toolIcons[tool.icon ?? ''] ?? Puzzle;
  return (
    <div className="overlay" onMouseDown={onCancel}>
      <section
        className="modal"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header tool-confirm-header">
          <span className="tool-icon">
            <Icon size={18} />
          </span>
          <h2 id="confirm-title">{t('toolbox.confirmTitle', { name: localized(tool.name) })}</h2>
        </header>
        <div className="tool-confirm-body">
          {tool.permissions.length > 0 && (
            <>
              <p>{t('toolbox.confirmIntro')}</p>
              <ul>
                {tool.permissions.map((item) => (
                  <li key={localized(item)}>{localized(item)}</li>
                ))}
              </ul>
            </>
          )}
          {needed.length > 0 && (
            <p className="amber-text">
              {t('toolbox.confirmMissing', {
                fields: needed
                  .map((field) => localized(field.label))
                  .join(t('common.listSeparator')),
              })}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <span className="grow" />
          <button className="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          {needed.length ? (
            <button className="button primary" onClick={onSetup}>
              {t('toolbox.fillSettings')}
            </button>
          ) : (
            <button className="button primary" onClick={onConfirm}>
              {t('toolbox.turnOn')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

const SECTIONS: { key: 'on' | 'off' | 'broken'; title: MessageKey }[] = [
  { key: 'on', title: 'toolbox.sectionOn' },
  { key: 'off', title: 'toolbox.sectionOff' },
  { key: 'broken', title: 'toolbox.sectionBroken' },
];

/** Installed tools as tiles: switch them on with consent, open them, change settings. */
export function ToolboxPage({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<'installed' | 'market'>('installed');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmId) setConfirmId(null);
      else setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmId]);
  const webPlugins = useWebPlugins();
  // A plugin's own page: declared by the server plugin, or registered by its web bundle.
  const pageOf = (tool: Tool) =>
    tool.page ?? pagesOf(webPlugins.filter((plugin) => plugin.requires === tool.id))[0]?.id;
  const opened = ctx.tools.find((tool) => tool.id === openId) ?? null;
  const confirming = ctx.tools.find((tool) => tool.id === confirmId) ?? null;

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return ctx.tools.filter((tool) =>
      words.every((word) =>
        [localized(tool.name), localized(tool.description), tool.id, tool.package ?? '']
          .join(' ')
          .toLowerCase()
          .includes(word),
      ),
    );
  }, [ctx.tools, query]);
  const groups = {
    on: visible.filter((tool) => tool.enabled && !tool.rejected),
    off: visible.filter((tool) => !tool.enabled && !tool.rejected),
    broken: visible.filter((tool) => tool.rejected),
  };

  async function setEnabled(tool: Tool, enabled: boolean) {
    try {
      await ctx.updateTool(tool.id, { enabled });
      ctx.notify(
        enabled
          ? t('toolbox.turnedOn', { name: localized(tool.name) })
          : t('toolbox.turnedOff', { name: localized(tool.name) }),
      );
    } catch (reason) {
      ctx.notify(settingError(tool, reason), 'error');
    }
  }
  function toggle(tool: Tool, enabled: boolean) {
    // Switching on is a decision: show what the tool will do first.
    if (enabled && (tool.permissions.length || missing(tool).length)) setConfirmId(tool.id);
    else void setEnabled(tool, enabled);
  }

  const bar = (
    <div className="toolbox-bar">
      <Chips
        label={t('nav.toolbox')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'installed', label: t('toolbox.installed'), count: ctx.tools.length },
          { value: 'market', label: t('toolbox.market') },
        ]}
      />
      {tab === 'installed' && ctx.tools.length > 3 && (
        <label className="search">
          <Search size={14} />
          <input
            value={query}
            placeholder={t('toolbox.search')}
            aria-label={t('toolbox.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
    </div>
  );

  if (tab === 'market')
    return (
      <>
        {bar}
        <MarketplaceTab ctx={ctx} />
      </>
    );
  return (
    <>
      {bar}
      {!ctx.tools.length ? (
        <Panel>
          <Empty title={t('toolbox.empty')} text={t('toolbox.emptyHint')} />
        </Panel>
      ) : (
        SECTIONS.filter((section) => groups[section.key].length).map((section) => (
          <section key={section.key} className="tool-section">
            <h2>
              {t(section.title)} <span className="count">{groups[section.key].length}</span>
            </h2>
            <div className="tool-tiles">
              {groups[section.key].map((tool) => (
                <ToolTile
                  key={tool.id}
                  tool={tool}
                  page={pageOf(tool)}
                  ctx={ctx}
                  onOpen={() => setOpenId(tool.id)}
                  onToggle={(enabled) => toggle(tool, enabled)}
                />
              ))}
            </div>
          </section>
        ))
      )}
      {query && !visible.length && <p className="page-note">{t('market.noMatch')}</p>}
      <p className="page-note">{t('toolbox.intro')}</p>
      {opened && (
        <ToolDrawer
          key={opened.id}
          tool={opened}
          page={pageOf(opened)}
          ctx={ctx}
          onClose={() => setOpenId(null)}
          onToggle={(enabled) => toggle(opened, enabled)}
        />
      )}
      {confirming && (
        <ConfirmEnable
          tool={confirming}
          onCancel={() => setConfirmId(null)}
          onSetup={() => {
            setConfirmId(null);
            setOpenId(confirming.id);
          }}
          onConfirm={() => {
            setConfirmId(null);
            void setEnabled(confirming, true);
          }}
        />
      )}
    </>
  );
}
