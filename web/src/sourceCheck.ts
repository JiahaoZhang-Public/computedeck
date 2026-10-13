import type { DriverInfo, Source } from './types';
import { formatMessage, localized, t } from './i18n';

/** Whether the first collection of a newly added source has finished. */
export function checkFinished(source: Source) {
  return !!source.last_attempt && source.status !== 'syncing' && source.status !== 'unconfigured'
    ? source.status === 'error' || !!source.last_success
    : false;
}

type CheckRow = { label: string; state: 'ok' | 'failed' | 'pending' | 'skipped'; detail?: string };

export function checklist(source: Source | undefined, info: DriverInfo): CheckRow[] {
  const done = !!source && checkFinished(source);
  const failed = done && source.status === 'error';
  const rows: CheckRow[] = [
    {
      label: t('source.check.connection'),
      state: !done ? 'pending' : failed ? 'failed' : 'ok',
      detail: failed ? formatMessage(source.error) : undefined,
    },
  ];
  for (const check of info.checks) {
    const notice = source?.warnings?.find(
      (item) => typeof item !== 'string' && item.code === check.warning,
    );
    rows.push({
      label: localized(check.label),
      state:
        !done || failed
          ? failed
            ? 'skipped'
            : 'pending'
          : source.capabilities.includes(check.capability)
            ? 'ok'
            : 'failed',
      detail: notice ? formatMessage(notice) : undefined,
    });
  }
  return rows;
}
