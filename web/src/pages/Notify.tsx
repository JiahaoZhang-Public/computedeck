import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../api';
import { errorText, formatMessage, localized, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { relativeTime } from '../domain';
import { OUTCOME_LABELS } from '../events';
import { channelSummary, EMPTY_RULE, listOf, smtpPortFor } from '../notify';
import type { Channel, NotifyState, Rule, RuleInput } from '../notify';
import { readSettings } from '../settingValues';
import { SettingInput } from '../SettingInput';
import { routeHash } from '../routes';
import { Empty, Panel, Status } from '../ui';
import type { Ctx } from './shared';

const BASE = '/plugins/notify';
const EVENT_LABELS: Record<string, MessageKey> = {
  'job.finished': 'notify.event.finished',
  'job.failed': 'notify.event.failed',
  'job.started': 'notify.event.started',
  'job.ended': 'notify.event.ended',
  'source.failed': 'notify.event.sourceFailed',
  'source.recovered': 'notify.event.sourceRecovered',
};
const STATUS: Record<string, string> = {
  sent: 'ready',
  failed: 'error',
  suppressed: 'stale',
  grouped: 'unknown',
  dropped: 'stale',
};

function ChannelEditor({
  state,
  channel,
  onDone,
}: {
  state: NotifyState;
  channel?: Channel;
  onDone: (saved: boolean) => void;
}) {
  const [kind, setKind] = useState(channel?.kind ?? state.kinds[0]?.kind ?? 'email');
  const [error, setError] = useState<string | null>(null);
  const spec = state.kinds.find((item) => item.kind === kind);
  // Whether the user typed a port; until then the port follows the email encryption.
  const portTouched = useRef(false);

  function changed(event: FormEvent<HTMLFormElement>) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (kind !== 'email') return;
    if (target.name === 'port') portTouched.current = true;
    if (target.name !== 'security') return;
    const port = event.currentTarget.elements.namedItem('port');
    if (!(port instanceof HTMLInputElement)) return;
    const next = smtpPortFor(target.value, port.value, portTouched.current);
    if (next != null) port.value = next;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spec) return;
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') ?? '').trim(),
      kind,
      config: readSettings(spec.fields, form),
    };
    try {
      await api(
        channel ? `${BASE}/channels/${encodeURIComponent(channel.id)}` : `${BASE}/channels`,
        body,
        channel ? 'PUT' : 'POST',
      );
      onDone(true);
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
    }
  }

  return (
    <form className="inline-editor" onSubmit={(event) => void save(event)} onChange={changed}>
      <div className="form-grid">
        <label>
          {t('notify.channel.name')}
          <input name="name" defaultValue={channel?.name ?? ''} required maxLength={80} autoFocus />
        </label>
        <label>
          {t('notify.channel.kind')}
          <select
            value={kind}
            disabled={!!channel}
            onChange={(event) => {
              portTouched.current = false;
              setKind(event.target.value);
            }}
          >
            {state.kinds.map((item) => (
              <option key={item.kind} value={item.kind}>
                {localized(item.label)}
              </option>
            ))}
          </select>
        </label>
        {spec?.fields.map((field) => (
          <SettingInput
            key={`${kind}:${field.key}`}
            field={field}
            value={channel?.config[field.key] ?? field.default}
          />
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" className="button" onClick={() => onDone(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary">
          {t('common.save')}
        </button>
      </footer>
    </form>
  );
}

function RuleEditor({
  state,
  rule,
  ctx,
  onDone,
}: {
  state: NotifyState;
  rule?: Rule;
  ctx: Ctx;
  onDone: (saved: boolean) => void;
}) {
  const start = rule ?? { ...EMPTY_RULE, channels: state.channels.slice(0, 1).map((c) => c.id) };
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    subject: string;
    body: string;
    example: boolean;
  } | null>(null);
  const clusters = ctx.groups.filter((group) => group.kind === 'cluster');

  function read(form: HTMLFormElement): RuleInput {
    const data = new FormData(form);
    const all = (name: string) => data.getAll(name).map(String);
    return {
      name: String(data.get('name') ?? '').trim(),
      enabled: data.get('enabled') === 'on',
      events: all('events'),
      clusters: all('clusters'),
      users: listOf(String(data.get('users') ?? '')),
      name_pattern: String(data.get('name_pattern') ?? '').trim(),
      channels: all('channels'),
      outcomes: all('outcomes'),
      subject: String(data.get('subject') ?? '').trim(),
      body: String(data.get('body') ?? '').trim(),
      include_log: data.get('include_log') === 'on',
      agent: data.get('agent') === 'on',
      instructions: String(data.get('instructions') ?? '').trim(),
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api(
        rule ? `${BASE}/rules/${encodeURIComponent(rule.id)}` : `${BASE}/rules`,
        read(event.currentTarget),
        rule ? 'PUT' : 'POST',
      );
      onDone(true);
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
    }
  }

  async function showPreview(form: HTMLFormElement | null) {
    if (!form) return;
    try {
      const body = read(form);
      setPreview(
        await api(`${BASE}/rules/preview`, {
          ...body,
          name: body.name || 'preview',
          channels: body.channels.length ? body.channels : ['preview'],
          events: body.events.length ? body.events : EMPTY_RULE.events,
          outcomes: body.events.length ? body.outcomes : EMPTY_RULE.outcomes,
        }),
      );
      setError(null);
    } catch (reason) {
      setError(errorText(reason, 'error.save'));
    }
  }

  return (
    <form className="inline-editor" onSubmit={(event) => void save(event)}>
      <div className="form-grid">
        <label className="span-two">
          {t('notify.rule.name')}
          <input
            name="name"
            defaultValue={start.name}
            placeholder={t('notify.rule.namePlaceholder')}
            required
            maxLength={80}
            autoFocus
          />
        </label>
        <fieldset className="span-two choice-group">
          <legend>{t('notify.rule.events')}</legend>
          {state.event_types.map((type) => (
            <label key={type} className="checkbox">
              <input
                type="checkbox"
                name="events"
                value={type}
                defaultChecked={start.events.includes(type)}
              />
              <span>{EVENT_LABELS[type] ? t(EVENT_LABELS[type]) : type}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="span-two choice-group">
          <legend>
            {t('notify.rule.outcomes')} <small>{t('notify.rule.outcomesHint')}</small>
          </legend>
          {Object.entries(OUTCOME_LABELS).map(([outcome, label]) => (
            <label key={outcome} className="checkbox">
              <input
                type="checkbox"
                name="outcomes"
                value={outcome}
                defaultChecked={start.outcomes?.includes(outcome)}
              />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
        {clusters.length > 0 && (
          <fieldset className="span-two choice-group">
            <legend>
              {t('notify.rule.clusters')} <small>{t('notify.rule.allIfNone')}</small>
            </legend>
            {clusters.map((group) => (
              <label key={group.key} className="checkbox">
                <input
                  type="checkbox"
                  name="clusters"
                  value={group.key}
                  defaultChecked={start.clusters.includes(group.key)}
                />
                <span>{group.label}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label>
          <span>
            {t('notify.rule.users')} <small className="optional">{t('common.optional')}</small>
          </span>
          <input name="users" defaultValue={start.users.join(', ')} placeholder="alice, bob" />
        </label>
        <label>
          <span>
            {t('notify.rule.pattern')} <small className="optional">{t('common.optional')}</small>
          </span>
          <input name="name_pattern" defaultValue={start.name_pattern} placeholder="llm-*" />
        </label>
        <fieldset className="span-two choice-group">
          <legend>{t('notify.rule.channels')}</legend>
          {state.channels.map((channel) => (
            <label key={channel.id} className="checkbox">
              <input
                type="checkbox"
                name="channels"
                value={channel.id}
                defaultChecked={start.channels.includes(channel.id)}
              />
              <span>{channel.name}</span>
            </label>
          ))}
        </fieldset>
        <label className="span-two">
          <span>
            {t('notify.rule.subject')} <small className="optional">{t('common.optional')}</small>
          </span>
          <input
            name="subject"
            defaultValue={start.subject}
            placeholder={t('notify.rule.templatePlaceholder')}
          />
        </label>
        <label className="span-two">
          <span>
            {t('notify.rule.body')} <small className="optional">{t('common.optional')}</small>
          </span>
          <textarea name="body" rows={4} defaultValue={start.body} />
          <small>
            {t('notify.rule.placeholders', {
              names: state.placeholders.map((name) => `{${name}}`).join(' '),
            })}
          </small>
        </label>
        <label className="checkbox span-two">
          <input type="checkbox" name="include_log" defaultChecked={start.include_log} />
          <span>
            {t('notify.rule.includeLog')}
            <small>{t('notify.rule.includeLogHint')}</small>
          </span>
        </label>
        <label className="checkbox span-two">
          <input
            type="checkbox"
            name="agent"
            defaultChecked={start.agent}
            disabled={!state.ai_ready && !start.agent}
          />
          <span>
            {t('notify.rule.agent')}
            <small>
              {state.ai_ready ? t('notify.rule.agentHint') : t('notify.rule.agentSetup')}{' '}
              {!state.ai_ready && (
                <a className="link" href={routeHash('toolbox')}>
                  {t('nav.toolbox')}
                </a>
              )}
            </small>
          </span>
        </label>
        <label className="span-two">
          <span>
            {t('notify.rule.instructions')}{' '}
            <small className="optional">{t('common.optional')}</small>
          </span>
          <textarea
            name="instructions"
            rows={3}
            defaultValue={start.instructions}
            placeholder={t('notify.rule.instructionsPlaceholder')}
          />
        </label>
        <label className="checkbox span-two">
          <input type="checkbox" name="enabled" defaultChecked={start.enabled} />
          <span>{t('notify.rule.enabled')}</span>
        </label>
      </div>
      {preview && (
        <div className="preview">
          <strong>{preview.subject}</strong>
          <pre>{preview.body}</pre>
          {preview.example && <small>{t('notify.preview.example')}</small>}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          type="button"
          className="button"
          onClick={(event) => void showPreview(event.currentTarget.form)}
        >
          {t('notify.preview')}
        </button>
        <span className="grow" />
        <button type="button" className="button" onClick={() => onDone(false)}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button primary" disabled={!state.channels.length}>
          {t('common.save')}
        </button>
      </footer>
    </form>
  );
}

/** Rules, channels and the delivery log of the notifications tool. */
export function NotifyPage({ ctx }: { ctx: Ctx }) {
  const [state, setState] = useState<NotifyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    { kind: 'channel'; item?: Channel } | { kind: 'rule'; item?: Rule } | null
  >(null);
  const tool = ctx.tools.find((item) => item.id === 'notify');

  const load = useCallback(
    () =>
      api<NotifyState>(BASE)
        .then((next) => {
          setState(next);
          setError(null);
        })
        .catch((reason) => setError(errorText(reason, 'error.service'))),
    [],
  );
  useEffect(() => {
    if (tool?.enabled) void load();
  }, [tool?.enabled, load]);

  if (!tool?.enabled)
    return (
      <Panel>
        <Empty
          title={t('notify.off')}
          text={t('notify.offHint')}
          action={
            <a className="button primary" href={routeHash('toolbox')}>
              {t('nav.toolbox')}
            </a>
          }
        />
      </Panel>
    );
  if (!state) return <Panel>{error ? <p className="panel-note red">{error}</p> : null}</Panel>;

  const done = (saved: boolean) => {
    setEditing(null);
    if (saved) void load();
  };
  async function remove(path: string, name: string) {
    if (!window.confirm(t('notify.removeConfirm', { name }))) return;
    try {
      await api(path, {}, 'DELETE');
      await load();
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    }
  }
  async function test(channel: Channel) {
    try {
      await api(`${BASE}/channels/${encodeURIComponent(channel.id)}/test`, {});
      ctx.notify(t('notify.testSent', { name: channel.name }));
    } catch (reason) {
      ctx.notify(errorText(reason, 'error.save'), 'error');
    }
    await load();
  }
  const kindLabel = (kind: string) =>
    localized(state.kinds.find((item) => item.kind === kind)?.label) || kind;
  const channelName = (id: string) => state.channels.find((item) => item.id === id)?.name ?? id;

  return (
    <>
      <p className="page-note">{t('notify.intro')}</p>
      <Panel
        title={t('notify.rules')}
        count={state.rules.length}
        actions={
          <button
            className="button small"
            disabled={!state.channels.length || ctx.demo}
            onClick={() => setEditing({ kind: 'rule' })}
          >
            <Plus size={13} /> {t('notify.addRule')}
          </button>
        }
      >
        {editing?.kind === 'rule' && (
          <RuleEditor state={state} rule={editing.item} ctx={ctx} onDone={done} />
        )}
        {state.rules.length ? (
          <ul className="rows">
            {state.rules.map((rule) => (
              <li key={rule.id}>
                <div className="grow">
                  <strong>
                    {rule.name}
                    {!rule.enabled && <span className="tag">{t('notify.paused')}</span>}
                    {rule.agent && <span className="tag">AI</span>}
                  </strong>
                  <span className="sub">
                    {rule.events
                      .map((type) => {
                        const label = EVENT_LABELS[type] ? t(EVENT_LABELS[type]) : type;
                        return type === 'job.finished' && rule.outcomes?.length
                          ? t('notify.rule.filteredOutcomes', {
                              event: label,
                              outcomes: rule.outcomes
                                .map((outcome) =>
                                  OUTCOME_LABELS[outcome] ? t(OUTCOME_LABELS[outcome]) : outcome,
                                )
                                .join(', '),
                            })
                          : label;
                      })
                      .join(', ')}
                    {' → '}
                    {rule.channels.map(channelName).join(', ')}
                  </span>
                </div>
                <button
                  className="icon-button"
                  aria-label={t('common.configure')}
                  onClick={() => setEditing({ kind: 'rule', item: rule })}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={t('common.remove')}
                  onClick={() =>
                    void remove(`${BASE}/rules/${encodeURIComponent(rule.id)}`, rule.name)
                  }
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          editing?.kind !== 'rule' && (
            <p className="panel-note">
              {state.channels.length ? t('notify.noRules') : t('notify.channelFirst')}
            </p>
          )
        )}
      </Panel>
      <Panel
        title={t('notify.channels')}
        count={state.channels.length}
        actions={
          <button
            className="button small"
            disabled={ctx.demo}
            onClick={() => setEditing({ kind: 'channel' })}
          >
            <Plus size={13} /> {t('notify.addChannel')}
          </button>
        }
      >
        {editing?.kind === 'channel' && (
          <ChannelEditor state={state} channel={editing.item} onDone={done} />
        )}
        {state.channels.length ? (
          <ul className="rows">
            {state.channels.map((channel) => (
              <li key={channel.id}>
                <div className="grow">
                  <strong>{channel.name}</strong>
                  <span className="sub">
                    {kindLabel(channel.kind)} ·{' '}
                    <span className="mono">{channelSummary(channel)}</span>
                  </span>
                </div>
                <button className="button small" onClick={() => void test(channel)}>
                  <Send size={13} /> {t('notify.test')}
                </button>
                <button
                  className="icon-button"
                  aria-label={t('common.configure')}
                  onClick={() => setEditing({ kind: 'channel', item: channel })}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label={t('common.remove')}
                  onClick={() =>
                    void remove(`${BASE}/channels/${encodeURIComponent(channel.id)}`, channel.name)
                  }
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          editing?.kind !== 'channel' && <p className="panel-note">{t('notify.noChannels')}</p>
        )}
      </Panel>
      <Panel title={t('notify.log')} count={state.log.length}>
        {state.log.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('notify.col.when')}</th>
                  <th>{t('notify.col.message')}</th>
                  <th>{t('notify.col.where')}</th>
                  <th>{t('clusters.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {state.log.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap">{relativeTime(row.at)}</td>
                    <td className="wrap">
                      {row.subject ?? '—'}
                      {row.count && row.status !== 'grouped' && row.status !== 'suppressed' && (
                        <span className="sub">{t('notify.groupCount', { count: row.count })}</span>
                      )}
                      <span className="sub">
                        {row.test ? t('notify.testRow') : (row.rule_name ?? row.rule ?? '')}
                        {row.notes?.length ? ` · ${row.notes.join(', ')}` : ''}
                      </span>
                    </td>
                    <td>{row.channel_name ?? row.channel ?? '—'}</td>
                    <td className="wrap">
                      <Status
                        state={STATUS[row.status] ?? 'unknown'}
                        label={
                          (row.status === 'grouped' || row.status === 'suppressed') && row.count
                            ? t(
                                row.status === 'grouped'
                                  ? 'notify.groupedCount'
                                  : 'notify.suppressedCount',
                                { count: row.count },
                              )
                            : t(`notify.status.${row.status}`)
                        }
                      />
                      {row.error && (
                        <span className="sub red-text">{formatMessage(row.error)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panel-note">{t('notify.noLog')}</p>
        )}
      </Panel>
    </>
  );
}
