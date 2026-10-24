import { Loader2 } from 'lucide-react';
import { t } from '../i18n';
import { Empty, Panel } from '../ui';

export function Loading({ id }: { id?: string }) {
  return (
    <div id={id} className="loading" aria-busy="true">
      <Loader2 className="spin" size={18} />
      {t('common.loading')}
    </div>
  );
}

export function LoadError({ id }: { id?: string }) {
  return (
    <Panel>
      <div id={id} role="alert">
        <Empty
          title={t('page.failed')}
          text={t('error.chunk')}
          action={
            <button className="button" onClick={() => window.location.reload()}>
              {t('common.retry')}
            </button>
          }
        />
      </div>
    </Panel>
  );
}
