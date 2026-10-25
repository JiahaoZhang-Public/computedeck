import { useEffect, useId } from 'react';
import { t } from '../i18n';
import { FocusView } from './Surface';

export function ConfirmDialog({
  title,
  outcome,
  close,
  confirm,
}: {
  title: string;
  outcome: string;
  close: () => void;
  confirm: () => void;
}) {
  const id = useId();
  useEffect(() => {
    window.addEventListener('popstate', close);
    window.addEventListener('hashchange', close);
    return () => {
      window.removeEventListener('popstate', close);
      window.removeEventListener('hashchange', close);
    };
  }, [close]);
  return (
    <FocusView labelledBy={id} close={close} initial="[data-safe]" className="confirm-dialog">
      <h2 id={id}>{title}</h2>
      <footer className="modal-footer">
        <button type="button" className="button" data-safe onClick={close}>
          {t('layer.keep')}
        </button>
        <button type="button" className="button" onClick={confirm}>
          {outcome}
        </button>
      </footer>
    </FocusView>
  );
}
