import type { SettingField, Tool } from './types';

/** Values of declared settings, as the Toolbox and plugin forms send them. */
export type Values = Tool['values'];

export function readSettings(fields: SettingField[], form: FormData): Values {
  const values: Values = {};
  for (const field of fields) {
    const raw = form.get(field.key);
    if (field.kind === 'boolean') values[field.key] = raw === 'on';
    else if (field.kind === 'number')
      values[field.key] = raw === '' || raw == null ? null : Number(raw);
    else values[field.key] = String(raw ?? '');
  }
  return values;
}
