import { errorText, t } from '../i18n';
import type { Ctx } from './shared';

/** Snoozing lives in an item's detail pane: two entries of its "⋯" menu, when it has an item. */
export function snoozeItems(
  ctx: Pick<Ctx, 'attention' | 'muteAttention' | 'notify'>,
  subject: string,
) {
  const item = (ctx.attention ?? []).find(
    (entry) => entry.subject.id === subject && !entry.muted && entry.mutable !== false,
  );
  if (!item) return [];
  const snooze = (until: '1h' | 'tomorrow') =>
    void ctx
      .muteAttention(item, 'snooze', until)
      .then(() => ctx.notify(t('attention.snoozedToast')))
      .catch((error) => ctx.notify(errorText(error, 'error.save'), 'error'));
  return [
    { id: 'snooze-1h', label: t('attention.oneHour'), action: () => snooze('1h') },
    { id: 'snooze-tomorrow', label: t('attention.tomorrow'), action: () => snooze('tomorrow') },
  ];
}
