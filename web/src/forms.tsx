import { ConnectionChecks } from './ConnectionChecks';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CheckCircle2, Cloud, Loader2, MinusCircle, Server, Terminal, XCircle } from 'lucide-react';
import type { CollectionNode, DriverField, DriverInfo, Instance, Kind, Source } from './types';
import type { Group } from './groups';
import { errorText, localized, t } from './i18n';
import type { MessageKey } from './i18n';
import { GroupMark } from './ui';
import { checkFinished, checklist } from './sourceCheck';
import { driverInfo, fieldValue, isCommonField, sortDrivers } from './drivers';

function FormFooter({
  busy,
  label,
  onCancel,
  error,
  extra,
}: {
  busy: boolean;
  label: string;
  onCancel: () => void;
  error: string | null;
  extra?: ReactNode;
}) {
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-footer">
        {extra}
        <span className="grow" />
        <button type="button" className="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="button primary" disabled={busy}>
          {busy && <Loader2 className="spin" size={14} />}
          {busy ? t('common.saving') : label}
        </button>
      </footer>
    </>
  );
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'AED', 'SGD', 'CAD', 'AUD'];

export function InstanceForm({
  item,
  platforms,
  where,
  busy,
  onSubmit,
  onCancel,
}: {
  item?: Instance;
  /** Platform names already in use, offered as suggestions. */
  platforms: string[];
  where: string;
  busy: boolean;
  onSubmit: (body: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const [existingAlias, setExistingAlias] = useState(item?.existing_alias ?? false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const body = {
      platform: item?.platform ?? String(values.platform ?? '').trim(),
      name: values.name,
      external_id: item?.external_id ?? values.external_id,
      host: values.host,
      port: existingAlias ? 22 : Number(values.port),
      username: existingAlias ? (item?.username ?? 'root') : values.username,
      identity_file: existingAlias ? null : values.identity_file || null,
      existing_alias: existingAlias,
      monitoring: values.monitoring === 'on',
      gpu_count: values.gpu_count ? Number(values.gpu_count) : null,
      gpu_type: values.gpu_type || null,
      hourly_cost: values.hourly_cost ? Number(values.hourly_cost) : null,
      currency: values.currency,
    };
    try {
      setFormError(null);
      await onSubmit(body);
    } catch (reason) {
      setFormError(errorText(reason, 'error.save'));
    }
  }
  return (
    <>
      <header className="modal-header">
        <h2 id="modal-title">
          {item ? t('instance.form.edit', { name: item.name }) : t('instance.form.add')}
        </h2>
        <p>{t('instance.form.intro')}</p>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <label>
            {t('instance.form.platform')}
            <input
              name="platform"
              list="instance-platforms"
              defaultValue={item?.platform ?? ''}
              placeholder={t('instance.form.platformPlaceholder')}
              disabled={!!item}
              required
              maxLength={60}
            />
            <datalist id="instance-platforms">
              {platforms.map((platform) => (
                <option key={platform} value={platform} />
              ))}
            </datalist>
          </label>
          <label>
            {t('instance.form.name')}
            <input
              name="name"
              defaultValue={item?.name}
              placeholder="gpu-box-01"
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <label className="span-two">
            {t('instance.form.externalId')}
            <input
              name="external_id"
              defaultValue={item?.external_id ?? ''}
              readOnly={!!item}
              placeholder={t('instance.form.externalIdPlaceholder')}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"
              required
            />
            <small>{t('instance.form.externalIdHint')}</small>
          </label>
          <label className="checkbox span-two">
            <input
              type="checkbox"
              checked={existingAlias}
              onChange={(event) => setExistingAlias(event.target.checked)}
            />
            <span>{t('instance.form.existingAlias', { where })}</span>
          </label>
          <label className={existingAlias ? 'span-two' : ''}>
            {existingAlias ? t('instance.form.alias') : t('instance.form.host')}
            <input
              name="host"
              defaultValue={item?.host ?? ''}
              placeholder={existingAlias ? 'gpu-box' : '192.0.2.10'}
              required
            />
          </label>
          {!existingAlias && (
            <>
              <label>
                {t('instance.form.port')}
                <input
                  name="port"
                  type="number"
                  defaultValue={item?.port ?? 22}
                  min="1"
                  max="65535"
                  required
                />
              </label>
              <label>
                {t('instance.username')}
                <input name="username" defaultValue={item?.username ?? 'root'} required />
              </label>
              <label>
                <span>
                  {t('instance.form.key', { where })} <small>{t('common.optional')}</small>
                </span>
                <input
                  name="identity_file"
                  defaultValue={item?.identity_file ?? ''}
                  placeholder="~/.ssh/id_ed25519"
                />
              </label>
            </>
          )}
          <label>
            <span>
              {t('instance.form.gpuCount')} <small>{t('common.optional')}</small>
            </span>
            <input
              name="gpu_count"
              defaultValue={item?.gpu_count ?? ''}
              type="number"
              min="0"
              max="1024"
            />
          </label>
          <label>
            <span>
              {t('instance.form.gpuType')} <small>{t('common.optional')}</small>
            </span>
            <input name="gpu_type" defaultValue={item?.gpu_type ?? ''} placeholder="RTX 4090" />
          </label>
          <label>
            <span>
              {t('instance.form.price')} <small>{t('common.optional')}</small>
            </span>
            <input
              name="hourly_cost"
              defaultValue={item?.hourly_cost ?? ''}
              type="number"
              min="0"
              step="0.001"
            />
          </label>
          <label>
            {t('instance.form.currency')}
            <select name="currency" defaultValue={item?.currency ?? 'USD'}>
              {[...new Set([...CURRENCIES, item?.currency ?? 'USD'])].map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox span-two">
            <input name="monitoring" type="checkbox" defaultChecked={item?.monitoring ?? false} />
            <span>{t('instance.form.monitoring', { where })}</span>
          </label>
        </div>
        <FormFooter
          busy={busy}
          error={formError}
          onCancel={onCancel}
          label={item ? t('common.save') : t('common.add')}
        />
      </form>
    </>
  );
}

type Step = 'type' | 'details' | 'check';

/** What an "add source" button already knows: a driver, a cluster to join, or a kind. */
export type SourcePreset = { driver?: string; clusterName?: string; kind?: Kind };

function TypeCard({ info, onChoose }: { info: DriverInfo; onChoose: () => void }) {
  const Icon = info.name === 'ssh' ? Terminal : info.kind === 'cluster' ? Server : Cloud;
  return (
    <button className="type-card" onClick={onChoose}>
      <Icon size={18} />
      <strong>
        {localized(info.label)}
        {info.beta && <span className="tag beta">{t('source.type.beta')}</span>}
      </strong>
      <span>{localized(info.description)}</span>
    </button>
  );
}

function FieldInput({
  field,
  value,
  where,
  half,
}: {
  field: DriverField;
  value: string;
  where: string;
  half: boolean;
}) {
  const name = `field:${field.key}`;
  return (
    <label className={half ? '' : 'span-two'}>
      <span>
        {localized(field.label)}
        {!field.required && <small className="optional"> {t('common.optional')}</small>}
      </span>
      {field.choices ? (
        <select name={name} defaultValue={value} required={field.required}>
          {!field.required && <option value="">—</option>}
          {field.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          defaultValue={value}
          placeholder={field.placeholder}
          pattern={field.pattern ?? undefined}
          required={field.required}
          maxLength={field.key === 'credential' ? 256 : 512}
        />
      )}
      {Object.keys(field.hint).length > 0 && <small>{localized(field.hint, { where })}</small>}
    </label>
  );
}

export function SourceForm({
  source,
  preset = {},
  drivers,
  nodes = [],
  sources,
  groups,
  where,
  busy,
  onSubmit,
  onDelete,
  onManual,
  onCancel,
}: {
  source?: Source;
  preset?: SourcePreset;
  /** Descriptions of the installed drivers, from `/api/drivers`. */
  drivers: DriverInfo[];
  /** Machines that can collect the source instead of this one. */
  nodes?: CollectionNode[];
  /** Current sources, used to follow the first collection of a new source. */
  sources: Source[];
  groups: Group[];
  where: string;
  busy: boolean;
  /** Creates a source, or updates `id` when given. */
  onSubmit: (body: unknown, id?: string) => Promise<Source>;
  onDelete: (source: Source) => Promise<void>;
  onManual: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>(source || preset.driver ? 'details' : 'type');
  const [selected, setSelected] = useState(source?.driver ?? preset.driver ?? '');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const info = driverInfo(drivers, selected);
  const cluster = info.kind === 'cluster';
  // A cluster joins an existing group only when the driver matches.
  const clusters = groups.filter(
    (group) => group.kind === 'cluster' && group.sources.some((item) => item.driver === selected),
  );
  const saved = sources.find((item) => item.id === savedId);
  const checking = step === 'check' && (!saved || !checkFinished(saved));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const enabled = form.get('enabled') === 'on';
    // After a failed check the new source exists; further saves update it.
    const target = source ?? saved;
    const values: Record<string, string> = {};
    const options: Record<string, string> = { ...(target?.options ?? {}) };
    for (const field of info.fields) {
      if (target && field.identity) continue;
      const value = String(form.get(`field:${field.key}`) ?? '').trim();
      if (isCommonField(field.key)) values[field.key] = value;
      // An emptied option is sent as '' and removed by the service.
      else options[field.key] = value;
    }
    const { username, ...connection } = values;
    let body: Record<string, unknown> = {
      enabled,
      interval_minutes: Number(form.get('interval_minutes')),
      ...connection,
      options,
      ...(form.has('node') ? { node: String(form.get('node') ?? '') } : {}),
    };
    if (!target) {
      const name = String(form.get('name') ?? '').trim();
      const existing = clusters.find((group) => group.label === name);
      body = {
        ...body,
        name,
        driver: selected,
        username: username || null,
        ...(existing ? { cluster_id: existing.key } : {}),
      };
    }
    try {
      setFormError(null);
      const result = await onSubmit(body, target?.id);
      if (!source && enabled) {
        setSavedId(result.id);
        setStep('check');
      } else onCancel();
    } catch (reason) {
      setFormError(errorText(reason, 'error.save'));
    }
  }

  if (step === 'type') {
    const choices = sortDrivers(drivers).filter(
      (driver) => !preset.kind || driver.kind === preset.kind,
    );
    const sections: { kind: Kind; title: MessageKey }[] = [
      { kind: 'cluster', title: 'source.type.clusters' },
      { kind: 'cloud', title: 'source.type.machines' },
    ];
    const shown = sections.filter((section) => !preset.kind || section.kind === preset.kind);
    return (
      <>
        <header className="modal-header">
          <h2 id="modal-title">{t('source.add')}</h2>
          <p>{t('source.type.intro')}</p>
        </header>
        {shown.map((section) => (
          <section key={section.kind} className="type-section">
            {shown.length > 1 && <h3>{t(section.title)}</h3>}
            <div className="type-cards">
              {choices
                .filter((driver) => driver.kind === section.kind)
                .map((driver) => (
                  <TypeCard
                    key={driver.name}
                    info={driver}
                    onChoose={() => {
                      setSelected(driver.name);
                      setStep('details');
                    }}
                  />
                ))}
              {section.kind === 'cloud' && (
                <button className="type-card" onClick={onManual}>
                  <Terminal size={18} />
                  <strong>{t('source.type.manual')}</strong>
                  <span>{t('source.type.manualHint')}</span>
                </button>
              )}
            </div>
          </section>
        ))}
      </>
    );
  }

  if (step === 'check')
    return (
      <>
        <header className="modal-header">
          <h2 id="modal-title">{t('source.check.title', { name: saved?.name ?? '' })}</h2>
          <p>
            {checking
              ? t('source.check.running')
              : saved?.status === 'error'
                ? t('source.check.failed')
                : t('source.check.done')}
          </p>
        </header>
        {savedId && <ConnectionChecks key={savedId} sourceId={savedId} />}
        <ul className="checklist">
          {checklist(saved, info).map((row) => (
            <li key={row.label} className={row.state}>
              {row.state === 'ok' ? (
                <CheckCircle2 size={16} />
              ) : row.state === 'failed' ? (
                <XCircle size={16} />
              ) : row.state === 'pending' ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <MinusCircle size={16} />
              )}
              <span>
                <strong>{row.label}</strong>
                {row.detail && <small>{row.detail}</small>}
              </span>
            </li>
          ))}
        </ul>
        <footer className="modal-footer">
          <span className="grow" />
          {saved?.status === 'error' && (
            <button className="button" onClick={() => setStep('details')}>
              {t('source.check.back')}
            </button>
          )}
          <button className="button primary" onClick={onCancel}>
            {t('common.done')}
          </button>
        </footer>
      </>
    );

  const editing = saved ?? source;
  const identity = info.fields.find((field) => field.identity);
  const shown = info.fields.filter((field) => !(editing && field.identity));
  return (
    <>
      <header className="modal-header">
        <h2 id="modal-title">{editing ? editing.name : localized(info.label)}</h2>
        <p>{localized(info.details, { where })}</p>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          {editing ? (
            <div className="source-identity span-two">
              <GroupMark group={groups.find((group) => group.key === editing.cluster_id)} />
              <div>
                <strong>{editing.name}</strong>
                <span>{(identity && fieldValue(editing, identity.key)) || editing.driver}</span>
              </div>
            </div>
          ) : (
            <label className={cluster && identity ? '' : 'span-two'}>
              {cluster ? t('source.form.cluster') : t('source.form.name')}
              <input
                name="name"
                list={cluster ? 'source-clusters' : undefined}
                defaultValue={preset.clusterName ?? info.default_name}
                placeholder={info.name_placeholder || info.default_name}
                maxLength={80}
                required
                autoFocus
              />
              {cluster && (
                <datalist id="source-clusters">
                  {clusters.map((group) => (
                    <option key={group.key} value={group.label} />
                  ))}
                </datalist>
              )}
            </label>
          )}
          {shown.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              where={where}
              half={cluster && field.identity}
              value={editing ? fieldValue(editing, field.key) : field.default}
            />
          ))}
          {(nodes.length > 0 || !!editing?.node) && (
            <label className="span-two">
              {t('source.form.node')}
              <select name="node" defaultValue={editing?.node ?? ''}>
                <option value="">
                  {where === t('where.local') ? where : t('source.form.nodeHere', { where })}
                </option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
              <small>{t('source.form.nodeHint', { where })}</small>
            </label>
          )}
          <label className="span-two">
            {t('source.form.interval')}
            <select name="interval_minutes" defaultValue={editing?.interval_minutes ?? 10}>
              {[...new Set([5, 10, 30, 60, editing?.interval_minutes ?? 10])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t('common.minutes', { count: minutes })}
                  </option>
                ))}
            </select>
          </label>
          <label className="checkbox span-two">
            <input name="enabled" type="checkbox" defaultChecked={editing?.enabled ?? true} />
            <span>{t('source.form.enabled')}</span>
          </label>
        </div>
        <FormFooter
          busy={busy}
          error={formError}
          onCancel={onCancel}
          label={editing ? t('common.save') : t('source.form.saveAndCheck')}
          extra={
            source ? (
              <button
                type="button"
                className="button danger-text"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('source.deleteConfirm', { name: source.name })))
                    void onDelete(source).catch((reason) =>
                      setFormError(errorText(reason, 'error.save')),
                    );
                }}
              >
                {t('common.remove')}
              </button>
            ) : !source && step === 'details' && !preset.driver ? (
              <button type="button" className="button" onClick={() => setStep('type')}>
                {t('common.back')}
              </button>
            ) : undefined
          }
        />
      </form>
    </>
  );
}
