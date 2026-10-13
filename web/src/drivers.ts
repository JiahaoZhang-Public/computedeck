import type { DriverField, DriverInfo, Kind, Source } from './types';

/** Fields every driver may use; any other field is stored in `source.options`. */
export const COMMON_FIELDS = ['username', 'ssh_alias', 'credential'] as const;
type CommonField = (typeof COMMON_FIELDS)[number];

export function isCommonField(key: string): key is CommonField {
  return (COMMON_FIELDS as readonly string[]).includes(key);
}

// Well-known drivers first, in the order people usually reach for them; others after.
const ORDER = ['slurm', 'kubernetes', 'pbs', 'lsf', 'ssh', 'runpod', 'vastai', 'lambda', 'aws-ec2'];

export function sortDrivers(drivers: DriverInfo[]): DriverInfo[] {
  const rank = (name: string) => {
    const index = ORDER.indexOf(name);
    return index < 0 ? ORDER.length : index;
  };
  return [...drivers].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The description of `name`, or a minimal one while the list loads or for an unknown driver. */
export function driverInfo(
  drivers: DriverInfo[],
  name: string,
  kind: Kind = 'cluster',
): DriverInfo {
  return (
    drivers.find((driver) => driver.name === name) ?? {
      name,
      kind,
      label: { en: name },
      description: {},
      details: {},
      fields: [],
      checks: [],
      default_name: '',
      name_placeholder: '',
      beta: false,
    }
  );
}

/** The field that tells one source of a group from another, e.g. the login or the API key. */
export function primaryField(info: DriverInfo): DriverField | undefined {
  return (
    info.fields.find((field) => field.identity) ??
    info.fields.find((field) => field.key === 'credential') ??
    info.fields.find((field) => field.key === 'ssh_alias')
  );
}

export function fieldValue(source: Source, key: string): string {
  return isCommonField(key) ? source[key] : (source.options?.[key] ?? '');
}
