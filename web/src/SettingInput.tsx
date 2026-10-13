import type { SettingField } from './types';
import type { Values } from './settingValues';
import { localized, t } from './i18n';

/** One input for a setting a plugin or channel declares. */
export function SettingInput({ field, value }: { field: SettingField; value: Values[string] }) {
  const common = { name: field.key, required: field.required };
  if (field.kind === 'boolean')
    return (
      <label className="checkbox span-two">
        <input type="checkbox" name={field.key} defaultChecked={value === true} />
        <span>{localized(field.label)}</span>
      </label>
    );
  return (
    <label className="span-two">
      <span>
        {localized(field.label)}
        {!field.required && <small className="optional"> {t('common.optional')}</small>}
      </span>
      {field.kind === 'select' ? (
        <select {...common} defaultValue={String(value ?? '')}>
          {!field.required && <option value="">—</option>}
          {(field.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : field.kind === 'textarea' ? (
        <textarea {...common} rows={4} defaultValue={String(value ?? '')} />
      ) : (
        <input
          {...common}
          type={field.kind === 'number' ? 'number' : 'text'}
          defaultValue={value == null ? '' : String(value)}
          placeholder={field.placeholder}
          pattern={field.kind === 'credential' ? '[a-z][a-z0-9-]*:.+' : undefined}
        />
      )}
      {Object.keys(field.hint).length > 0 && <small>{localized(field.hint)}</small>}
    </label>
  );
}
